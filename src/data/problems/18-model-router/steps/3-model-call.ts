import type {Step} from '@/lib/types';

// ---- 3. The model call: deadline, retries, fallback, breaker ----------------------------------------
export const modelCallStep: Step = {
  id: 'model-call',
  title: 'The model call: bounded retries, a fallback, a breaker',
  concept: 'grpc',
  file: 'model_call',
  focus: ['router', 'large', 'small', 'redis'],
  task: `## Task

**Starting point.** The starter is \`complete(model, prompt, max_tokens)\`, the call routerd makes to
the model a decision named: it sends \`Model.Complete\` to the deployment at \`{model}:9000\` and
returns the model that answered with its reply. On any error it sleeps \`RETRY_BACKOFF_S\` and calls
the same model again. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A deployment that stalls or goes down: the call waits on it
without limit, repeats a request the model already refused, never ends while the deployment is down,
never tries the small model that was healthy all along, and keeps calling a deployment that fails
every call.

- Each attempt carries an **800 ms** deadline (\`ATTEMPT_TIMEOUT_S = 0.8\`).
- At most **ATTEMPTS = 3** attempts per model, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried; any other status is raised to the caller at once.
- When a model's attempts are spent, the same loop runs on **FALLBACK_MODEL** (\`gpt-4o-mini\`),
  unless that was the model asked for; when both are spent, raise.
- A breaker per model at \`circuit:{model}\`: \`INCR\` on each retryable failure with a **30 s**
  expiry; at **5** the value becomes \`open\` for 30 s, and while it is open the model is skipped
  without a call.`,
  sequence: {
    participants: ['routerd', 'Redis', 'gpt-4o', 'gpt-4o-mini'],
    messages: [
      {from: 'routerd', to: 'Redis', label: 'GET circuit:gpt-4o', kind: 'sync'},
      {from: 'Redis', to: 'routerd', label: 'nil (closed)', kind: 'reply'},
      {from: 'routerd', to: 'gpt-4o', label: 'Complete · deadline 800 ms (× 3)', kind: 'sync'},
      {from: 'gpt-4o', to: 'routerd', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'routerd', to: 'Redis', label: 'INCR circuit:gpt-4o · EXPIRE 30', kind: 'sync'},
      {from: 'routerd', to: 'gpt-4o-mini', label: 'Complete · deadline 800 ms', kind: 'sync'},
      {from: 'gpt-4o-mini', to: 'routerd', label: 'CompleteReply{text, usage}', kind: 'reply'},
    ],
  },
  hints: [
    'With gpt-4o down, one request shows up as hundreds of calls on its dashboard and never answers while gpt-4o-mini sits idle; a request gpt-4o rejected as invalid is sent again and again; a stalled deployment holds every worker.',
    'The loop has no bound and no deadline, catches every status alike, sleeps and dials the same model, and keeps no count of failures that another call or replica could read.',
    'Loop over `[model, FALLBACK_MODEL]` and `range(ATTEMPTS)` with `timeout=ATTEMPT_TIMEOUT_S`; re-raise unless the code is UNAVAILABLE or DEADLINE_EXCEEDED; on those `INCR circuit:{model}` (EXPIRE 30 on the first, `open` with EX 30 at 5); skip a model whose circuit is open.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries the 800 ms deadline',
      detail:
        'Each `Complete` call is made with the 800 ms deadline (`timeout=`, `deadline:`, a context with timeout, `withDeadlineAfter`, `set_deadline`); a stalled deployment then ends in DEADLINE_EXCEEDED and the next attempt or the fallback gets its turn.',
      match: {
        python: {all: [/\.Complete\([^)]*timeout\s*=/]},
        typescript: {all: [/\.Complete\([^)]*deadline\s*:/]},
        go: {all: [/context\.With(Timeout|Deadline)\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'bounded',
      title: 'At most three attempts per model, then an error',
      detail:
        'The attempts on a model are counted against `ATTEMPTS`; a `while True` / `for {}` retry with a sleep spins until something kills the process.',
      match: {
        python: {all: [/range\(\s*ATTEMPTS\s*\)|<\s*ATTEMPTS/], none: [/while\s+True/]},
        typescript: {all: [/<\s*ATTEMPTS/], none: [/for\s*\(\s*;\s*;\s*\)|while\s*\(\s*true\s*\)/]},
        go: {all: [/range\s+attempts\b|<\s*attempts\b/], none: [/for\s*\{/]},
        scala: {all: [/<\s*Attempts\b|until\s+Attempts\b|to\s+Attempts\b/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/<\s*kAttempts\b/], none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/]},
      },
    },
    {
      id: 'retryable',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'The status code decides: `UNAVAILABLE` and `DEADLINE_EXCEEDED` are worth another attempt, anything else (`INVALID_ARGUMENT`, `PERMISSION_DENIED`) is raised at once and counts nowhere.',
      match: {
        python: {all: [/\.code\(\)/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/\.code\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/status\.Code\(/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/getStatus\.getCode/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/error_code\(\)/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'fallback',
      title: 'Falls back to gpt-4o-mini',
      detail:
        "Once the asked-for model's attempts are spent, the same bounded loop runs on `FALLBACK_MODEL` at its own address, and the answer names the model that served it.",
      match: {
        python: {all: [/FALLBACK_MODEL/]},
        typescript: {all: [/FALLBACK_MODEL/]},
        go: {all: [/fallbackModel/]},
        scala: {all: [/FallbackModel/]},
        cpp: {all: [/kFallbackModel/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens circuit:{model} after five failures for 30 s',
      detail:
        '`circuit:{model}` counts retryable failures with INCR and a 30 s expiry; at five it is set to `open` for 30 s and the model is skipped until it expires, by every replica.',
      match: {
        python: {all: [/f["']circuit:\{/, /\.incr\(/, /["']open["']/, /\.expire\(|\bex\s*=/]},
        typescript: {all: [/`circuit:\$\{/, /\.incr\(/, /['"]open['"]/, /\.expire\(|['"]EX['"]/]},
        go: {all: [/"circuit:"\s*\+|"circuit:%s"/, /\.Incr\(/, /"open"/, /\.Expire\(/]},
        scala: {all: [/s"circuit:\$/, /\.incr\(/, /"open"/, /\.expire\(|\.setex\(/]},
        cpp: {all: [/"circuit:"\s*\+/, /\.incr\(/, /"open"/, /\.expire\(|\.setex\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import models_pb2
import models_pb2_grpc

RETRY_BACKOFF_S = 0.2

stubs = {}


def stub(model: str) -> models_pb2_grpc.ModelStub:
    """One channel per model deployment, at {model}:9000."""
    if model not in stubs:
        stubs[model] = models_pb2_grpc.ModelStub(grpc.insecure_channel(f"{model}:9000"))
    return stubs[model]


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def complete(model: str, prompt: str, max_tokens: int):
    """The model that answered and its reply, trying again after a failure."""
    request = models_pb2.CompleteRequest(model=model, prompt=prompt, max_tokens=max_tokens)
    while True:
        try:
            return model, stub(model).Complete(request)
        except grpc.RpcError:
            time.sleep(RETRY_BACKOFF_S)
`,
      solution: `import grpc
import redis

import models_pb2
import models_pb2_grpc

ATTEMPTS = 3
ATTEMPT_TIMEOUT_S = 0.8
FALLBACK_MODEL = "gpt-4o-mini"
BREAKER_FAILURES = 5
BREAKER_TTL_S = 30
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stubs = {}


class ModelUnavailable(Exception):
    pass


def stub(model: str) -> models_pb2_grpc.ModelStub:
    """One channel per model deployment, at {model}:9000."""
    if model not in stubs:
        stubs[model] = models_pb2_grpc.ModelStub(grpc.insecure_channel(f"{model}:9000"))
    return stubs[model]


def breaker_open(model: str) -> bool:
    return r.get(f"circuit:{model}") == "open"


def note_failure(model: str) -> None:
    key = f"circuit:{model}"
    failures = r.incr(key)
    if failures == 1:
        r.expire(key, BREAKER_TTL_S)
    if failures >= BREAKER_FAILURES:
        r.set(key, "open", ex=BREAKER_TTL_S)


def complete(model: str, prompt: str, max_tokens: int):
    """The model that answered and its reply: up to ATTEMPTS on the model, then on the fallback."""
    candidates = [model] if model == FALLBACK_MODEL else [model, FALLBACK_MODEL]
    for candidate in candidates:
        request = models_pb2.CompleteRequest(model=candidate, prompt=prompt, max_tokens=max_tokens)
        for _ in range(ATTEMPTS):
            if breaker_open(candidate):
                break
            try:
                return candidate, stub(candidate).Complete(request, timeout=ATTEMPT_TIMEOUT_S)
            except grpc.RpcError as exc:
                if exc.code() not in RETRYABLE:
                    raise  # the request itself is wrong: no other attempt or model takes it
                note_failure(candidate)
    raise ModelUnavailable(f"{model} and {FALLBACK_MODEL} failed")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const RETRY_BACKOFF_MS = 200;

interface CompleteRequest {
  model: string;
  prompt: string;
  max_tokens: number;
}
export interface CompleteReply {
  text: string;
  usage: {input_tokens: number; output_tokens: number};
}
type ModelStub = grpc.Client & {
  Complete(request: CompleteRequest, options: grpc.CallOptions): Promise<CompleteReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('models.proto')) as unknown as {
  routerd: {Model: grpc.ServiceClientConstructor};
};
const stubs = new Map<string, ModelStub>();

/** One channel per model deployment, at {model}:9000. */
function stub(model: string): ModelStub {
  let found = stubs.get(model);
  if (found === undefined) {
    found = new pkg.routerd.Model(\`\${model}:9000\`, grpc.credentials.createInsecure()) as ModelStub;
    stubs.set(model, found);
  }
  return found;
}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** The model that answered and its reply, trying again after a failure. */
export async function complete(model: string, prompt: string, maxTokens: number): Promise<{model: string; reply: CompleteReply}> {
  const request = {model, prompt, max_tokens: maxTokens};
  for (;;) {
    try {
      return {model, reply: await stub(model).Complete(request, {})};
    } catch {
      await sleep(RETRY_BACKOFF_MS);
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

export const ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 800;
export const FALLBACK_MODEL = 'gpt-4o-mini';
export const BREAKER_FAILURES = 5;
export const BREAKER_TTL_S = 30;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface CompleteRequest {
  model: string;
  prompt: string;
  max_tokens: number;
}
export interface CompleteReply {
  text: string;
  usage: {input_tokens: number; output_tokens: number};
}
type ModelStub = grpc.Client & {
  Complete(request: CompleteRequest, options: grpc.CallOptions): Promise<CompleteReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('models.proto')) as unknown as {
  routerd: {Model: grpc.ServiceClientConstructor};
};
const stubs = new Map<string, ModelStub>();
const redis = new Redis({host: 'redis', port: 6379});

export class ModelUnavailable extends Error {}

/** One channel per model deployment, at {model}:9000. */
function stub(model: string): ModelStub {
  let found = stubs.get(model);
  if (found === undefined) {
    found = new pkg.routerd.Model(\`\${model}:9000\`, grpc.credentials.createInsecure()) as ModelStub;
    stubs.set(model, found);
  }
  return found;
}

async function breakerOpen(model: string): Promise<boolean> {
  return (await redis.get(\`circuit:\${model}\`)) === 'open';
}

async function noteFailure(model: string): Promise<void> {
  const key = \`circuit:\${model}\`;
  const failures = await redis.incr(key);
  if (failures === 1) await redis.expire(key, BREAKER_TTL_S);
  if (failures >= BREAKER_FAILURES) await redis.set(key, 'open', 'EX', BREAKER_TTL_S);
}

/** The model that answered and its reply: up to ATTEMPTS on the model, then on the fallback. */
export async function complete(model: string, prompt: string, maxTokens: number): Promise<{model: string; reply: CompleteReply}> {
  const candidates = model === FALLBACK_MODEL ? [model] : [model, FALLBACK_MODEL];
  for (const candidate of candidates) {
    const request = {model: candidate, prompt, max_tokens: maxTokens};
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (await breakerOpen(candidate)) break;
      try {
        return {model: candidate, reply: await stub(candidate).Complete(request, {deadline: Date.now() + ATTEMPT_TIMEOUT_MS})};
      } catch (e) {
        if (!RETRYABLE.has((e as grpc.ServiceError).code)) throw e; // the request itself is wrong
        await noteFailure(candidate);
      }
    }
  }
  throw new ModelUnavailable(\`\${model} and \${FALLBACK_MODEL} failed\`);
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

	pb "routerd/gen/models"
)

const retryBackoff = 200 * time.Millisecond

var clients = map[string]pb.ModelClient{}

// client is one channel per model deployment, at {model}:9000.
func client(model string) pb.ModelClient {
	c, ok := clients[model]
	if !ok {
		conn, _ := grpc.NewClient(model+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
		c = pb.NewModelClient(conn)
		clients[model] = c
	}
	return c
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// complete returns the model that answered and its reply, trying again after a failure.
func complete(ctx context.Context, model, prompt string, maxTokens int) (string, *pb.CompleteReply, error) {
	req := &pb.CompleteRequest{Model: model, Prompt: prompt, MaxTokens: int32(maxTokens)}
	for {
		reply, err := client(model).Complete(ctx, req)
		if err == nil {
			return model, reply, nil
		}
		time.Sleep(retryBackoff)
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "routerd/gen/models"
)

const (
	attempts        = 3
	attemptTimeout  = 800 * time.Millisecond
	fallbackModel   = "gpt-4o-mini"
	breakerFailures = 5
	breakerTTL      = 30 * time.Second
)

var clients = map[string]pb.ModelClient{}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var errModelUnavailable = errors.New("the model and its fallback failed")

// client is one channel per model deployment, at {model}:9000.
func client(model string) pb.ModelClient {
	c, ok := clients[model]
	if !ok {
		conn, _ := grpc.NewClient(model+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
		c = pb.NewModelClient(conn)
		clients[model] = c
	}
	return c
}

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func breakerOpen(ctx context.Context, model string) bool {
	v, _ := rdb.Get(ctx, "circuit:"+model).Result()
	return v == "open"
}

func noteFailure(ctx context.Context, model string) {
	key := "circuit:" + model
	failures, _ := rdb.Incr(ctx, key).Result()
	if failures == 1 {
		rdb.Expire(ctx, key, breakerTTL)
	}
	if failures >= breakerFailures {
		rdb.Set(ctx, key, "open", breakerTTL)
	}
}

// complete returns the model that answered and its reply: up to attempts on the model, then on the fallback.
func complete(ctx context.Context, model, prompt string, maxTokens int) (string, *pb.CompleteReply, error) {
	candidates := []string{model}
	if model != fallbackModel {
		candidates = append(candidates, fallbackModel)
	}
	for _, candidate := range candidates {
		req := &pb.CompleteRequest{Model: candidate, Prompt: prompt, MaxTokens: int32(maxTokens)}
		for range attempts {
			if breakerOpen(ctx, candidate) {
				break
			}
			attempt, cancel := context.WithTimeout(ctx, attemptTimeout)
			reply, err := client(candidate).Complete(attempt, req)
			cancel()
			if err == nil {
				return candidate, reply, nil
			}
			if !retryable(err) {
				return "", nil, err // the request itself is wrong: no other attempt or model takes it
			}
			noteFailure(ctx, candidate)
		}
	}
	return "", nil, errModelUnavailable
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import routerd.models.{CompleteReply, CompleteRequest, ModelGrpc}

import scala.collection.mutable

object ModelCall {
  val RetryBackoffMillis = 200L

  private val stubs = mutable.Map.empty[String, ModelGrpc.ModelBlockingStub]

  /** One channel per model deployment, at {model}:9000. */
  def stub(model: String): ModelGrpc.ModelBlockingStub =
    stubs.getOrElseUpdate(model, ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress(model, 9000).usePlaintext().build()))

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /** The model that answered and its reply, trying again after a failure. */
  def complete(model: String, prompt: String, maxTokens: Int): (String, CompleteReply) = {
    val request = CompleteRequest(model = model, prompt = prompt, maxTokens = maxTokens)
    var answer: Option[(String, CompleteReply)] = None
    while (answer.isEmpty) {
      try answer = Some((model, stub(model).complete(request)))
      catch {
        case _: StatusRuntimeException => Thread.sleep(RetryBackoffMillis)
      }
    }
    answer.get
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import routerd.models.{CompleteReply, CompleteRequest, ModelGrpc}

import scala.collection.mutable

object ModelCall {
  val Attempts = 3
  val AttemptTimeoutMillis = 800L
  val FallbackModel = "gpt-4o-mini"
  val BreakerFailures = 5L
  val BreakerTtlSeconds = 30L
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val jedis = new JedisPooled("redis", 6379)
  private val stubs = mutable.Map.empty[String, ModelGrpc.ModelBlockingStub]

  class ModelUnavailable(model: String) extends RuntimeException(s"$model and $FallbackModel failed")

  /** One channel per model deployment, at {model}:9000. */
  def stub(model: String): ModelGrpc.ModelBlockingStub =
    stubs.getOrElseUpdate(model, ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress(model, 9000).usePlaintext().build()))

  def breakerOpen(model: String): Boolean = jedis.get(s"circuit:$model") == "open"

  def noteFailure(model: String): Unit = {
    val key = s"circuit:$model"
    val failures = jedis.incr(key)
    if (failures == 1L) jedis.expire(key, BreakerTtlSeconds)
    if (failures >= BreakerFailures) jedis.setex(key, BreakerTtlSeconds, "open")
  }

  /** The model that answered and its reply: up to Attempts on the model, then on the fallback. */
  def complete(model: String, prompt: String, maxTokens: Int): (String, CompleteReply) = {
    val candidates = if (model == FallbackModel) Iterator(model) else Iterator(model, FallbackModel)
    var answer: Option[(String, CompleteReply)] = None
    while (answer.isEmpty && candidates.hasNext) {
      val candidate = candidates.next()
      val request = CompleteRequest(model = candidate, prompt = prompt, maxTokens = maxTokens)
      var attempt = 0
      while (answer.isEmpty && attempt < Attempts && !breakerOpen(candidate)) {
        attempt += 1
        try answer = Some((candidate, stub(candidate).withDeadlineAfter(AttemptTimeoutMillis, TimeUnit.MILLISECONDS).complete(request)))
        catch {
          case e: StatusRuntimeException =>
            if (!Retryable.contains(e.getStatus.getCode)) throw e // the request itself is wrong
            noteFailure(candidate)
        }
      }
    }
    answer.getOrElse(throw new ModelUnavailable(model))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <thread>

#include "models.grpc.pb.h"

constexpr std::chrono::milliseconds kRetryBackoff{200};

struct Completion {
  std::string model;
  routerd::CompleteReply reply;
};

std::map<std::string, std::unique_ptr<routerd::Model::Stub>> stubs;

// One channel per model deployment, at {model}:9000.
routerd::Model::Stub& stub(const std::string& model) {
  auto& found = stubs[model];
  if (!found) found = routerd::Model::NewStub(grpc::CreateChannel(model + ":9000", grpc::InsecureChannelCredentials()));
  return *found;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// The model that answered and its reply, trying again after a failure.
Completion complete(const std::string& model, const std::string& prompt, int max_tokens) {
  routerd::CompleteRequest request;
  request.set_model(model);
  request.set_prompt(prompt);
  request.set_max_tokens(max_tokens);
  while (true) {
    grpc::ClientContext ctx;
    Completion out{model, {}};
    if (stub(model).Complete(&ctx, request, &out.reply).ok()) return out;
    std::this_thread::sleep_for(kRetryBackoff);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "models.grpc.pb.h"

constexpr int kAttempts = 3;
constexpr std::chrono::milliseconds kAttemptTimeout{800};
const std::string kFallbackModel = "gpt-4o-mini";
constexpr long long kBreakerFailures = 5;
constexpr std::chrono::seconds kBreakerTtl{30};

struct Completion {
  std::string model;
  routerd::CompleteReply reply;
};

// A refused request as the caller sees it: the status the model answered.
struct ModelError : std::runtime_error {
  grpc::StatusCode code;
  ModelError(grpc::StatusCode c, const std::string& what) : std::runtime_error(what), code(c) {}
};

struct ModelUnavailable : std::runtime_error {
  explicit ModelUnavailable(const std::string& model) : std::runtime_error(model + " and " + kFallbackModel + " failed") {}
};

std::map<std::string, std::unique_ptr<routerd::Model::Stub>> stubs;
sw::redis::Redis redis("tcp://redis:6379");

// One channel per model deployment, at {model}:9000.
routerd::Model::Stub& stub(const std::string& model) {
  auto& found = stubs[model];
  if (!found) found = routerd::Model::NewStub(grpc::CreateChannel(model + ":9000", grpc::InsecureChannelCredentials()));
  return *found;
}

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

bool breaker_open(const std::string& model) {
  const auto v = redis.get("circuit:" + model);
  return v && *v == "open";
}

void note_failure(const std::string& model) {
  const std::string key = "circuit:" + model;
  const long long failures = redis.incr(key);
  if (failures == 1) redis.expire(key, kBreakerTtl);
  if (failures >= kBreakerFailures) redis.setex(key, kBreakerTtl, "open");
}

// The model that answered and its reply: up to kAttempts on the model, then on the fallback.
Completion complete(const std::string& model, const std::string& prompt, int max_tokens) {
  std::vector<std::string> candidates = {model};
  if (model != kFallbackModel) candidates.push_back(kFallbackModel);
  for (const auto& candidate : candidates) {
    routerd::CompleteRequest request;
    request.set_model(candidate);
    request.set_prompt(prompt);
    request.set_max_tokens(max_tokens);
    for (int attempt = 0; attempt < kAttempts; attempt++) {
      if (breaker_open(candidate)) break;
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kAttemptTimeout);
      Completion out{candidate, {}};
      const grpc::Status status = stub(candidate).Complete(&ctx, request, &out.reply);
      if (status.ok()) return out;
      // The request itself is wrong: no other attempt or model takes it.
      if (!retryable(status.error_code())) throw ModelError(status.error_code(), status.error_message());
      note_failure(candidate);
    }
  }
  throw ModelUnavailable(model);
}
`,
    },
  },
  harness: {
    python: `import grpc

import models_pb2
import models_pb2_grpc

LARGE, SMALL = "gpt-4o:9000", "gpt-4o-mini:9000"


class Deployment(models_pb2_grpc.ModelServicer):
    """A model deployment: answers with its own name."""

    def __init__(self, name):
        self.name = name

    def Complete(self, request, context):
        return models_pb2.CompleteReply(text=f"{self.name} answers", usage=models_pb2.Usage(input_tokens=12, output_tokens=7))


def _world(ctx):
    ctx.grpc.serve(models_pb2_grpc.add_ModelServicer_to_server, Deployment("gpt-4o"), LARGE)
    ctx.grpc.serve(models_pb2_grpc.add_ModelServicer_to_server, Deployment("gpt-4o-mini"), SMALL)
    return ctx.load("model_call")


def _run(ctx, m, model="gpt-4o"):
    """One call: the model that answered, its text and the exception it raised; ended is False if it never returned."""
    out = {"model": None, "text": None, "error": None}

    def call():
        try:
            served, reply = m.complete(model, "Summarise this ticket.", 64)
            out["model"], out["text"] = served, reply.text
        except Exception as exc:  # noqa: BLE001 - whatever the call ended with is the outcome
            out["error"] = exc
        return True

    ctx.clock.sleep_limit = ctx.clock.sleeps + 200  # a loop that backs off and retries forever is stopped here, as Ctrl-C would
    out["ended"] = bool(ctx.drain(call))
    return out


def _calls(ctx, target):
    return len(ctx.grpc.calls_to("Complete", target))


async def check_deadline(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Complete", 2.0, LARGE)
    out = _run(ctx, m)
    assert out["ended"], f"with gpt-4o stalled the call never ended ({_calls(ctx, LARGE)} attempts on it): every attempt needs a deadline"
    large = ctx.grpc.calls_to("Complete", LARGE)
    assert large and large[0].timeout is not None, "the Complete call to gpt-4o carries no deadline: a stalled deployment holds the worker as long as it likes"
    assert 0.7 <= large[0].timeout <= 0.9, f"each attempt's deadline must be 800 ms, got {large[0].timeout} s"
    assert out["error"] is None and out["model"] == "gpt-4o-mini", f"after gpt-4o timed out on every attempt the fallback must answer; got model {out['model']!r} and {out['error']!r}"
    assert len(large) == 3, f"gpt-4o was tried {len(large)} times, expected 3 attempts of 800 ms"


async def check_bounded(ctx):
    m = _world(ctx)
    ctx.grpc.stop(LARGE)
    ctx.grpc.stop(SMALL)
    out = _run(ctx, m)
    total = _calls(ctx, LARGE) + _calls(ctx, SMALL)
    assert out["ended"], f"with both deployments down the call never ended: {total} attempts and counting. Bound the attempts per model"
    assert out["error"] is not None, f"with both deployments down the call must raise, it returned {out['model']!r}"
    assert _calls(ctx, LARGE) <= 3 and _calls(ctx, SMALL) <= 3, f"with both deployments down the call made {_calls(ctx, LARGE)} attempts on gpt-4o and {_calls(ctx, SMALL)} on gpt-4o-mini, expected at most 3 each"


async def check_retryable(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.INVALID_ARGUMENT, "max_tokens exceeds the context window", times=1, target=LARGE)
    out = _run(ctx, m)
    assert out["ended"] and out["error"] is not None, f"INVALID_ARGUMENT from gpt-4o must be raised to the caller at once, the call returned {out['model']!r}"
    assert _calls(ctx, LARGE) == 1, f"INVALID_ARGUMENT is not retryable: gpt-4o was called {_calls(ctx, LARGE)} times, expected once"
    assert _calls(ctx, SMALL) == 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried, the request itself is wrong"
    assert ctx.redis.get("circuit:gpt-4o") is None, "a non-retryable failure must not count towards the breaker"
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "gpt-4o restarting", times=1, target=LARGE)
    out = _run(ctx, m)
    assert out["error"] is None and out["model"] == "gpt-4o", f"one UNAVAILABLE must be retried on gpt-4o, got model {out['model']!r} and {out['error']!r}"
    assert _calls(ctx, LARGE) == 3, f"gpt-4o was called {_calls(ctx, LARGE)} times in all, expected 1 + 2 (one refusal, then one retried failure)"


async def check_fallback(ctx):
    m = _world(ctx)
    ctx.grpc.stop(LARGE)
    out = _run(ctx, m)
    assert out["ended"], "with gpt-4o down the call never ended: fall back to gpt-4o-mini once gpt-4o's attempts are spent"
    assert out["error"] is None and out["model"] == "gpt-4o-mini", f"with gpt-4o down gpt-4o-mini must answer, got model {out['model']!r} and {out['error']!r}"
    assert out["text"] == "gpt-4o-mini answers", f"the reply must be gpt-4o-mini's, got {out['text']!r}"
    assert _calls(ctx, LARGE) == 3 and _calls(ctx, SMALL) == 1, f"expected 3 attempts on gpt-4o and 1 on gpt-4o-mini, got {_calls(ctx, LARGE)} and {_calls(ctx, SMALL)}"
    ctx.grpc.stop(SMALL)
    out = _run(ctx, m, model="gpt-4o-mini")
    assert out["ended"] and out["error"] is not None, "a call for gpt-4o-mini with gpt-4o-mini down has nothing to fall back to and must raise"
    assert _calls(ctx, LARGE) == 3, "a call for gpt-4o-mini must not fall back to gpt-4o"


async def check_breaker(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "gpt-4o overloaded", times=5, target=LARGE)
    first = _run(ctx, m)
    second = _run(ctx, m)
    state = ctx.redis.get("circuit:gpt-4o")
    assert state == "open", f"after five retryable failures circuit:gpt-4o is {state!r}, expected 'open'"
    ttl = ctx.redis.ttl("circuit:gpt-4o")
    assert 0 < ttl <= 30, f"circuit:gpt-4o must expire within 30 s, its TTL is {ttl}"
    assert _calls(ctx, LARGE) == 5, f"gpt-4o was called {_calls(ctx, LARGE)} times: once its circuit opened at the fifth failure the next attempt must not be made"
    assert first["model"] == second["model"] == "gpt-4o-mini", f"while gpt-4o fails the fallback answers, got {first['model']!r} then {second['model']!r}"
    third = _run(ctx, m)
    assert _calls(ctx, LARGE) == 5, "while the circuit is open gpt-4o must be skipped without a call"
    assert third["model"] == "gpt-4o-mini", f"while the circuit is open gpt-4o-mini answers, got {third['model']!r} and {third['error']!r}"
    ctx.clock.advance(31)
    fourth = _run(ctx, m)
    assert _calls(ctx, LARGE) == 6 and fourth["model"] == "gpt-4o", "once the circuit has expired gpt-4o gets its turn again"
`,
    typescript: `const LARGE = 'gpt-4o:9000';
const SMALL = 'gpt-4o-mini:9000';

/** A model deployment: answers with its own name. */
const deployment = (name: string) => ({
  Complete(_call, callback) {
    callback(null, {text: \`\${name} answers\`, usage: {input_tokens: 12, output_tokens: 7}});
  },
});

function world(ctx) {
  const pkg = ctx.proto('models.proto');
  ctx.grpc.serve(pkg.routerd.Model.service, deployment('gpt-4o'), LARGE);
  ctx.grpc.serve(pkg.routerd.Model.service, deployment('gpt-4o-mini'), SMALL);
  return ctx.load('model_call');
}

/** One call: the model that answered, its text and the error it threw; ended is false if it never returned. */
async function run(ctx, m, model = 'gpt-4o') {
  const out: {model: string | null; text: string | null; error: unknown; ended: boolean} = {model: null, text: null, error: null, ended: false};
  const call = async () => {
    try {
      const answer = await m.complete(model, 'Summarise this ticket.', 64);
      out.model = answer.model;
      out.text = answer.reply.text;
    } catch (e) {
      out.error = e;
    }
    return true;
  };
  out.ended = (await ctx.drain(call())) === true;
  return out;
}

const calls = (ctx, target: string): number => ctx.grpc.callsTo('Complete', target).length;

export async function check_deadline(ctx) {
  const m = world(ctx);
  ctx.grpc.setLatency('Complete', 2.0, LARGE);
  const out = await run(ctx, m);
  assert(out.ended, \`with gpt-4o stalled the call never ended (\${calls(ctx, LARGE)} attempts on it): every attempt needs a deadline\`);
  const large = ctx.grpc.callsTo('Complete', LARGE);
  assert(large.length > 0 && large[0].timeout !== null, 'the Complete call to gpt-4o carries no deadline: a stalled deployment holds the worker as long as it likes');
  assert(0.7 <= large[0].timeout && large[0].timeout <= 0.9, \`each attempt's deadline must be 800 ms, got \${large[0].timeout} s\`);
  assert(out.error === null && out.model === 'gpt-4o-mini', \`after gpt-4o timed out on every attempt the fallback must answer; got model \${JSON.stringify(out.model)} and \${out.error}\`);
  assert.equal(large.length, 3, \`gpt-4o was tried \${large.length} times, expected 3 attempts of 800 ms\`);
}

export async function check_bounded(ctx) {
  const m = world(ctx);
  ctx.grpc.stop(LARGE);
  ctx.grpc.stop(SMALL);
  const out = await run(ctx, m);
  const total = calls(ctx, LARGE) + calls(ctx, SMALL);
  assert(out.ended, \`with both deployments down the call never ended: \${total} attempts and counting. Bound the attempts per model\`);
  assert(out.error !== null, \`with both deployments down the call must throw, it returned \${JSON.stringify(out.model)}\`);
  assert(calls(ctx, LARGE) <= 3 && calls(ctx, SMALL) <= 3, \`with both deployments down the call made \${calls(ctx, LARGE)} attempts on gpt-4o and \${calls(ctx, SMALL)} on gpt-4o-mini, expected at most 3 each\`);
}

export async function check_retryable(ctx) {
  const m = world(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.INVALID_ARGUMENT, 'max_tokens exceeds the context window', 1, LARGE);
  let out = await run(ctx, m);
  assert(out.ended && out.error !== null, \`INVALID_ARGUMENT from gpt-4o must be thrown to the caller at once, the call returned \${JSON.stringify(out.model)}\`);
  assert.equal(calls(ctx, LARGE), 1, \`INVALID_ARGUMENT is not retryable: gpt-4o was called \${calls(ctx, LARGE)} times, expected once\`);
  assert.equal(calls(ctx, SMALL), 0, 'INVALID_ARGUMENT is not retryable: the fallback must not be tried, the request itself is wrong');
  assert.equal(ctx.redis.get('circuit:gpt-4o'), null, 'a non-retryable failure must not count towards the breaker');
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'gpt-4o restarting', 1, LARGE);
  out = await run(ctx, m);
  assert(out.error === null && out.model === 'gpt-4o', \`one UNAVAILABLE must be retried on gpt-4o, got model \${JSON.stringify(out.model)} and \${out.error}\`);
  assert.equal(calls(ctx, LARGE), 3, \`gpt-4o was called \${calls(ctx, LARGE)} times in all, expected 1 + 2 (one refusal, then one retried failure)\`);
}

export async function check_fallback(ctx) {
  const m = world(ctx);
  ctx.grpc.stop(LARGE);
  let out = await run(ctx, m);
  assert(out.ended, "with gpt-4o down the call never ended: fall back to gpt-4o-mini once gpt-4o's attempts are spent");
  assert(out.error === null && out.model === 'gpt-4o-mini', \`with gpt-4o down gpt-4o-mini must answer, got model \${JSON.stringify(out.model)} and \${out.error}\`);
  assert.equal(out.text, 'gpt-4o-mini answers', \`the reply must be gpt-4o-mini's, got \${JSON.stringify(out.text)}\`);
  assert(calls(ctx, LARGE) === 3 && calls(ctx, SMALL) === 1, \`expected 3 attempts on gpt-4o and 1 on gpt-4o-mini, got \${calls(ctx, LARGE)} and \${calls(ctx, SMALL)}\`);
  ctx.grpc.stop(SMALL);
  out = await run(ctx, m, 'gpt-4o-mini');
  assert(out.ended && out.error !== null, 'a call for gpt-4o-mini with gpt-4o-mini down has nothing to fall back to and must throw');
  assert.equal(calls(ctx, LARGE), 3, 'a call for gpt-4o-mini must not fall back to gpt-4o');
}

export async function check_breaker(ctx) {
  const m = world(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'gpt-4o overloaded', 5, LARGE);
  const first = await run(ctx, m);
  const second = await run(ctx, m);
  const state = ctx.redis.get('circuit:gpt-4o');
  assert.equal(state, 'open', \`after five retryable failures circuit:gpt-4o is \${JSON.stringify(state)}, expected 'open'\`);
  const ttl = Number(ctx.redis.ttl('circuit:gpt-4o'));
  assert(0 < ttl && ttl <= 30, \`circuit:gpt-4o must expire within 30 s, its TTL is \${ttl}\`);
  assert.equal(calls(ctx, LARGE), 5, \`gpt-4o was called \${calls(ctx, LARGE)} times: once its circuit opened at the fifth failure the next attempt must not be made\`);
  assert(first.model === 'gpt-4o-mini' && second.model === 'gpt-4o-mini', \`while gpt-4o fails the fallback answers, got \${JSON.stringify(first.model)} then \${JSON.stringify(second.model)}\`);
  const third = await run(ctx, m);
  assert.equal(calls(ctx, LARGE), 5, 'while the circuit is open gpt-4o must be skipped without a call');
  assert.equal(third.model, 'gpt-4o-mini', \`while the circuit is open gpt-4o-mini answers, got \${JSON.stringify(third.model)} and \${third.error}\`);
  ctx.clock.advance(31);
  const fourth = await run(ctx, m);
  assert(calls(ctx, LARGE) === 6 && fourth.model === 'gpt-4o', 'once the circuit has expired gpt-4o gets its turn again');
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	"leetbuild/harness"

	pb "routerd/gen/models"
)

const (
	largeTarget = "gpt-4o:9000"
	smallTarget = "gpt-4o-mini:9000"
)

// deploymentPeer is a model deployment: it answers with its own name.
type deploymentPeer struct {
	pb.UnimplementedModelServer
	name string
}

func (p *deploymentPeer) Complete(_ context.Context, _ *pb.CompleteRequest) (*pb.CompleteReply, error) {
	return &pb.CompleteReply{Text: p.name + " answers", Usage: &pb.Usage{InputTokens: 12, OutputTokens: 7}}, nil
}

func modelWorld(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(largeTarget), &deploymentPeer{name: "gpt-4o"})
	pb.RegisterModelServer(ctx.GRPC.Server(smallTarget), &deploymentPeer{name: "gpt-4o-mini"})
}

type modelOut struct {
	model, text string
	err         error
	ended       bool
}

// modelRun is one call: the model that answered, its text and the error; ended is false if it never returned.
func modelRun(ctx *harness.Ctx, model string) modelOut {
	var out modelOut
	out.ended = ctx.Drain(func() {
		served, reply, err := complete(context.Background(), model, "Summarise this ticket.", 64)
		out.model, out.err = served, err
		if reply != nil {
			out.text = reply.GetText()
		}
	})
	return out
}

func modelCalls(ctx *harness.Ctx, target string) int {
	return len(ctx.GRPC.CallsTo("Complete", target))
}

func CheckDeadline(ctx *harness.Ctx) {
	modelWorld(ctx)
	ctx.GRPC.SetLatency("Complete", 2.0, largeTarget)
	out := modelRun(ctx, "gpt-4o")
	ctx.Assert(out.ended, "with gpt-4o stalled the call never ended (%d attempts on it): every attempt needs a deadline", modelCalls(ctx, largeTarget))
	large := ctx.GRPC.CallsTo("Complete", largeTarget)
	ctx.Assert(len(large) > 0 && large[0].HasDeadline(), "the Complete call to gpt-4o carries no deadline: a stalled deployment holds the worker as long as it likes")
	ctx.Assert(700*time.Millisecond <= large[0].Timeout && large[0].Timeout <= 900*time.Millisecond, "each attempt's deadline must be 800 ms, got %v", large[0].Timeout)
	ctx.Assert(out.err == nil && out.model == "gpt-4o-mini", "after gpt-4o timed out on every attempt the fallback must answer; got model %q and %v", out.model, out.err)
	ctx.Equal(len(large), 3, "gpt-4o attempts (3 of 800 ms each)")
}

func CheckBounded(ctx *harness.Ctx) {
	modelWorld(ctx)
	ctx.GRPC.Stop(largeTarget)
	ctx.GRPC.Stop(smallTarget)
	out := modelRun(ctx, "gpt-4o")
	total := modelCalls(ctx, largeTarget) + modelCalls(ctx, smallTarget)
	ctx.Assert(out.ended, "with both deployments down the call never ended: %d attempts and counting. Bound the attempts per model", total)
	ctx.Assert(out.err != nil, "with both deployments down the call must return an error, it returned model %q", out.model)
	ctx.Assert(modelCalls(ctx, largeTarget) <= 3 && modelCalls(ctx, smallTarget) <= 3, "with both deployments down the call made %d attempts on gpt-4o and %d on gpt-4o-mini, expected at most 3 each", modelCalls(ctx, largeTarget), modelCalls(ctx, smallTarget))
}

func CheckRetryable(ctx *harness.Ctx) {
	modelWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.InvalidArgument, "max_tokens exceeds the context window", 1, largeTarget)
	out := modelRun(ctx, "gpt-4o")
	ctx.Assert(out.ended && out.err != nil, "INVALID_ARGUMENT from gpt-4o must be returned to the caller at once, the call returned model %q", out.model)
	ctx.Equal(modelCalls(ctx, largeTarget), 1, "INVALID_ARGUMENT is not retryable; gpt-4o calls")
	ctx.Equal(modelCalls(ctx, smallTarget), 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried, the request itself is wrong; gpt-4o-mini calls")
	_, counted := ctx.Redis.Get("circuit:gpt-4o")
	ctx.Assert(!counted, "a non-retryable failure must not count towards the breaker")
	ctx.GRPC.Fail("Complete", codes.Unavailable, "gpt-4o restarting", 1, largeTarget)
	out = modelRun(ctx, "gpt-4o")
	ctx.Assert(out.err == nil && out.model == "gpt-4o", "one UNAVAILABLE must be retried on gpt-4o, got model %q and %v", out.model, out.err)
	ctx.Equal(modelCalls(ctx, largeTarget), 3, "gpt-4o calls in all (1 + 2: one refusal, then one retried failure)")
}

func CheckFallback(ctx *harness.Ctx) {
	modelWorld(ctx)
	ctx.GRPC.Stop(largeTarget)
	out := modelRun(ctx, "gpt-4o")
	ctx.Assert(out.ended, "with gpt-4o down the call never ended: fall back to gpt-4o-mini once gpt-4o's attempts are spent")
	ctx.Assert(out.err == nil && out.model == "gpt-4o-mini", "with gpt-4o down gpt-4o-mini must answer, got model %q and %v", out.model, out.err)
	ctx.Equal(out.text, "gpt-4o-mini answers", "the reply must be gpt-4o-mini's")
	ctx.Assert(modelCalls(ctx, largeTarget) == 3 && modelCalls(ctx, smallTarget) == 1, "expected 3 attempts on gpt-4o and 1 on gpt-4o-mini, got %d and %d", modelCalls(ctx, largeTarget), modelCalls(ctx, smallTarget))
	ctx.GRPC.Stop(smallTarget)
	out = modelRun(ctx, "gpt-4o-mini")
	ctx.Assert(out.ended && out.err != nil, "a call for gpt-4o-mini with gpt-4o-mini down has nothing to fall back to and must return an error")
	ctx.Equal(modelCalls(ctx, largeTarget), 3, "a call for gpt-4o-mini must not fall back to gpt-4o; gpt-4o calls")
}

func CheckBreaker(ctx *harness.Ctx) {
	modelWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "gpt-4o overloaded", 5, largeTarget)
	first := modelRun(ctx, "gpt-4o")
	second := modelRun(ctx, "gpt-4o")
	state, _ := ctx.Redis.Get("circuit:gpt-4o")
	ctx.Equal(state, "open", "after five retryable failures circuit:gpt-4o")
	ttl := ctx.Redis.TTL("circuit:gpt-4o")
	ctx.Assert(0 < ttl && ttl <= 30, "circuit:gpt-4o must expire within 30 s, its TTL is %d", ttl)
	ctx.Equal(modelCalls(ctx, largeTarget), 5, "once the circuit opened at the fifth failure the next attempt must not be made; gpt-4o calls")
	ctx.Assert(first.model == "gpt-4o-mini" && second.model == "gpt-4o-mini", "while gpt-4o fails the fallback answers, got %q then %q", first.model, second.model)
	third := modelRun(ctx, "gpt-4o")
	ctx.Equal(modelCalls(ctx, largeTarget), 5, "while the circuit is open gpt-4o must be skipped without a call; gpt-4o calls")
	ctx.Assert(third.model == "gpt-4o-mini", "while the circuit is open gpt-4o-mini answers, got %q and %v", third.model, third.err)
	ctx.Clock.Advance(31)
	fourth := modelRun(ctx, "gpt-4o")
	ctx.Assert(modelCalls(ctx, largeTarget) == 6 && fourth.model == "gpt-4o", "once the circuit has expired gpt-4o gets its turn again")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <string>

namespace {

const std::string kLargeTarget = "gpt-4o:9000";
const std::string kSmallTarget = "gpt-4o-mini:9000";

// A model deployment: answers with its own name.
class DeploymentPeer final : public routerd::Model::Service {
 public:
  explicit DeploymentPeer(std::string name) : name_(std::move(name)) {}

  grpc::Status Complete(grpc::ServerContext*, const routerd::CompleteRequest*, routerd::CompleteReply* reply) override {
    reply->set_text(name_ + " answers");
    reply->mutable_usage()->set_input_tokens(12);
    reply->mutable_usage()->set_output_tokens(7);
    return grpc::Status::OK;
  }

 private:
  std::string name_;
};

struct ModelWorld {
  DeploymentPeer large{"gpt-4o"};
  DeploymentPeer small{"gpt-4o-mini"};
};

void modelWorld(harness::Ctx& ctx) {
  static ModelWorld* w = nullptr;
  delete w;
  w = new ModelWorld;
  ctx.GRPC.Server(kLargeTarget)->RegisterService(&w->large);
  ctx.GRPC.Server(kSmallTarget)->RegisterService(&w->small);
}

struct ModelOut {
  std::string model, text;
  std::string error;  // what the call threw, "" if it returned
  bool ended = false;
};

// One call: the model that answered, its text and what it threw; ended is false if it never returned.
ModelOut modelRun(harness::Ctx& ctx, const std::string& model = "gpt-4o") {
  ModelOut out;
  out.ended = ctx.Drain([&] {
    try {
      const auto answer = complete(model, "Summarise this ticket.", 64);
      out.model = answer.model;
      out.text = answer.reply.text();
    } catch (const std::exception& e) {
      out.error = e.what()[0] ? e.what() : "an exception";
    }
  });
  return out;
}

size_t modelCalls(harness::Ctx& ctx, const std::string& target) { return ctx.GRPC.CallsTo("Complete", target).size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  modelWorld(ctx);
  ctx.GRPC.SetLatency("Complete", 2.0, kLargeTarget);
  const auto out = modelRun(ctx);
  ctx.Assert(out.ended, "with gpt-4o stalled the call never ended (%d attempts on it): every attempt needs a deadline", modelCalls(ctx, kLargeTarget));
  const auto large = ctx.GRPC.CallsTo("Complete", kLargeTarget);
  ctx.Assert(!large.empty() && large[0].HasDeadline(), "the Complete call to gpt-4o carries no deadline: a stalled deployment holds the worker as long as it likes");
  ctx.Assert(0.7 <= large[0].TimeoutSeconds() && large[0].TimeoutSeconds() <= 0.9, "each attempt's deadline must be 800 ms, got %vs", large[0].TimeoutSeconds());
  ctx.Assert(out.error.empty() && out.model == "gpt-4o-mini", "after gpt-4o timed out on every attempt the fallback must answer; got model %q and %s", out.model, out.error);
  ctx.Equal(large.size(), 3, "gpt-4o attempts (3 of 800 ms each)");
}

void CheckBounded(harness::Ctx& ctx) {
  modelWorld(ctx);
  ctx.GRPC.Stop(kLargeTarget);
  ctx.GRPC.Stop(kSmallTarget);
  const auto out = modelRun(ctx);
  const size_t total = modelCalls(ctx, kLargeTarget) + modelCalls(ctx, kSmallTarget);
  ctx.Assert(out.ended, "with both deployments down the call never ended: %d attempts and counting. Bound the attempts per model", total);
  ctx.Assert(!out.error.empty(), "with both deployments down the call must throw, it returned model %q", out.model);
  ctx.Assert(modelCalls(ctx, kLargeTarget) <= 3 && modelCalls(ctx, kSmallTarget) <= 3, "with both deployments down the call made %d attempts on gpt-4o and %d on gpt-4o-mini, expected at most 3 each", modelCalls(ctx, kLargeTarget), modelCalls(ctx, kSmallTarget));
}

void CheckRetryable(harness::Ctx& ctx) {
  modelWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::INVALID_ARGUMENT, "max_tokens exceeds the context window", 1, kLargeTarget);
  auto out = modelRun(ctx);
  ctx.Assert(out.ended && !out.error.empty(), "INVALID_ARGUMENT from gpt-4o must be thrown to the caller at once, the call returned model %q", out.model);
  ctx.Equal(modelCalls(ctx, kLargeTarget), 1, "INVALID_ARGUMENT is not retryable; gpt-4o calls");
  ctx.Equal(modelCalls(ctx, kSmallTarget), 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried, the request itself is wrong; gpt-4o-mini calls");
  ctx.Assert(!ctx.Redis.Get("circuit:gpt-4o"), "a non-retryable failure must not count towards the breaker");
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "gpt-4o restarting", 1, kLargeTarget);
  out = modelRun(ctx);
  ctx.Assert(out.error.empty() && out.model == "gpt-4o", "one UNAVAILABLE must be retried on gpt-4o, got model %q and %s", out.model, out.error);
  ctx.Equal(modelCalls(ctx, kLargeTarget), 3, "gpt-4o calls in all (1 + 2: one refusal, then one retried failure)");
}

void CheckFallback(harness::Ctx& ctx) {
  modelWorld(ctx);
  ctx.GRPC.Stop(kLargeTarget);
  auto out = modelRun(ctx);
  ctx.Assert(out.ended, "with gpt-4o down the call never ended: fall back to gpt-4o-mini once gpt-4o's attempts are spent");
  ctx.Assert(out.error.empty() && out.model == "gpt-4o-mini", "with gpt-4o down gpt-4o-mini must answer, got model %q and %s", out.model, out.error);
  ctx.Equal(out.text, "gpt-4o-mini answers", "the reply must be gpt-4o-mini's");
  ctx.Assert(modelCalls(ctx, kLargeTarget) == 3 && modelCalls(ctx, kSmallTarget) == 1, "expected 3 attempts on gpt-4o and 1 on gpt-4o-mini, got %d and %d", modelCalls(ctx, kLargeTarget), modelCalls(ctx, kSmallTarget));
  ctx.GRPC.Stop(kSmallTarget);
  out = modelRun(ctx, "gpt-4o-mini");
  ctx.Assert(out.ended && !out.error.empty(), "a call for gpt-4o-mini with gpt-4o-mini down has nothing to fall back to and must throw");
  ctx.Equal(modelCalls(ctx, kLargeTarget), 3, "a call for gpt-4o-mini must not fall back to gpt-4o; gpt-4o calls");
}

void CheckBreaker(harness::Ctx& ctx) {
  modelWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "gpt-4o overloaded", 5, kLargeTarget);
  const auto first = modelRun(ctx);
  const auto second = modelRun(ctx);
  ctx.Equal(ctx.Redis.Get("circuit:gpt-4o"), "open", "after five retryable failures circuit:gpt-4o");
  const long long ttl = ctx.Redis.TTL("circuit:gpt-4o");
  ctx.Assert(0 < ttl && ttl <= 30, "circuit:gpt-4o must expire within 30 s, its TTL is %d", ttl);
  ctx.Equal(modelCalls(ctx, kLargeTarget), 5, "once the circuit opened at the fifth failure the next attempt must not be made; gpt-4o calls");
  ctx.Assert(first.model == "gpt-4o-mini" && second.model == "gpt-4o-mini", "while gpt-4o fails the fallback answers, got %q then %q", first.model, second.model);
  const auto third = modelRun(ctx);
  ctx.Equal(modelCalls(ctx, kLargeTarget), 5, "while the circuit is open gpt-4o must be skipped without a call; gpt-4o calls");
  ctx.Assert(third.model == "gpt-4o-mini", "while the circuit is open gpt-4o-mini answers, got %q and %s", third.model, third.error);
  ctx.Clock.Advance(31);
  const auto fourth = modelRun(ctx);
  ctx.Assert(modelCalls(ctx, kLargeTarget) == 6 && fourth.model == "gpt-4o", "once the circuit has expired gpt-4o gets its turn again");
}
`,
  },
  debrief: `Each bound answers a different question. The deadline bounds one attempt, so a stalled deployment costs 800 ms instead of a worker. The attempt count bounds one model, and the status filter decides which failures are worth repeating: \`INVALID_ARGUMENT\` fails the same way on every attempt and every model. The fallback turns an outage of the large model into cheaper answers instead of errors. The breaker lives in Redis so every replica stops calling a deployment one of them watched fail, and its expiry is what lets traffic back. Production routers add jittered backoff between attempts, a retry budget so retries cannot multiply load during an outage, and a half-open state that sends one probe request before closing the circuit.`,
};
