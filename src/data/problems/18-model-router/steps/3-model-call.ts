import type {Step} from '@/lib/types';

export const modelCallStep: Step = {
  id: 'model-call',
  title: 'Provider call: deadline, bounded retries, breaker',
  concept: 'grpc',
  file: 'model_call',
  focus: ['router', 'provider', 'fallback'],
  task: `## Task

The starter is a plausible model-generated draft: when the provider is healthy it streams tokens
correctly, so the demo passes. Every failure path is wrong. Find them, fix them, and prove the fix.

Implement \`generate(model, prompt, on_token)\` for the router’s provider layer:

- Each attempt carries an **800 ms** deadline. A call without one lets one stuck provider pin the
  worker indefinitely.
- At most **3 attempts per provider**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retryable; every other status is returned to the caller immediately.
- When the primary’s attempts are exhausted, try the **fallback model** once through the same
  bounded loop.
- A **circuit breaker** opens after **5** retryable failures and stays open for **30 s**; while it
  is open, skip that provider instead of hammering it.
- Once the **first token has been delivered** to the caller, **never retry**: a replay would
  duplicate output the user already read and bill it twice.

**Failure mode the checks target.** The draft catches every error and loops forever: a permanent
\`INVALID_ARGUMENT\` spins the worker, a bad deployment becomes a hot loop against a struggling
provider, there is nothing to fall back to, and after a partial answer the draft replays the stream
from the start. Each of those is silent in a demo and loud in production.`,
  sequence: {
    participants: ['Model Router', 'Provider', 'Fallback'],
    messages: [
      {from: 'Model Router', to: 'Model Router', label: 'breaker.allow() · open → skip', kind: 'sync'},
      {from: 'Model Router', to: 'Provider', label: 'Stream · deadline 800 ms · attempt ≤ 3', kind: 'sync'},
      {from: 'Provider', to: 'Model Router', label: 'tokens … then UNAVAILABLE', kind: 'reply'},
      {from: 'Model Router', to: 'Model Router', label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'sync'},
      {from: 'Model Router', to: 'Fallback', label: 'Stream · fallback model', kind: 'sync'},
      {from: 'Fallback', to: 'Model Router', label: 'tokens', kind: 'async'},
      {
        from: 'Model Router',
        to: 'Model Router',
        label: 'first token delivered → no replay, fail the request',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call changes nothing. Bound the attempts with a constant and a `for` loop: the draft’s `while True` has no exit for a permanent error like `INVALID_ARGUMENT`.',
    'Retryability is a property of the status, not of “it threw”: capture the error, compare its code against `UNAVAILABLE` / `DEADLINE_EXCEEDED`, and return anything else to the caller immediately.',
    'A breaker is a failure counter per provider: record only retryable failures, check it before each attempt, and open it for 30 s after five. Track `delivered` as you yield tokens: once a token is out, a retry is a duplicate, so raise instead.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries an 800 ms deadline',
      detail:
        'The call is created with an 800 ms deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. Without it a stuck provider holds the request open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.8/, /timeout=DEADLINE_S/, /\.Stream\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*800/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Stream\(/]},
        go: {all: [/(deadlineMS|800)/, /context\.WithTimeout|WithDeadline/, /\.Stream\(/]},
        scala: {all: [/(DeadlineMs|800)/, /withDeadlineAfter/, /\.stream\(/]},
        cpp: {all: [/(kDeadlineMs|800)/, /set_deadline\(/, /->Stream\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most three attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The draft retries every error forever.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'fallback',
      title: 'Fails over to the fallback model',
      detail:
        'When the primary’s attempts are exhausted, the same bounded loop runs against the fallback model. The draft only ever talks to the primary.',
      match: {
        python: {all: [/fallback/, /\.Stream\(/]},
        typescript: {all: [/fallback/, /\.Stream\(/]},
        go: {all: [/fallback/, /\.Stream\(/]},
        scala: {all: [/fallback/, /\.stream\(/]},
        cpp: {all: [/fallback/, /->Stream\(/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five failures for 30 s',
      detail:
        'A failure counter opens the breaker after `BREAKER_FAILURES = 5` retryable failures for `BREAKER_COOLDOWN_S = 30`, and `allow()` is checked before each attempt so an open breaker skips the provider.',
      match: {
        python: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        typescript: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        go: {all: [/breakerFailures\s*=\s*5/, /breakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
        scala: {all: [/BreakerFailures\s*=\s*5/, /BreakerCooldownS\s*=\s*30/, /\.allow\(/]},
        cpp: {all: [/kBreakerFailures\s*=\s*5/, /kBreakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
      },
    },
    {
      id: 'no-replay',
      title: 'Never retries after the first streamed token',
      detail:
        'Once a token has been delivered to the caller, a retry would replay output the user already read. Track `delivered` and raise or return instead of retrying.',
      match: {
        python: {all: [/delivered\s*=\s*True/, /if delivered:/]},
        typescript: {all: [/delivered\s*=\s*true/, /if\s*\(delivered\)/]},
        go: {all: [/delivered\s*=\s*true/, /if delivered\s*\{/]},
        scala: {all: [/delivered\s*=\s*true/, /if \(delivered\)/]},
        cpp: {all: [/delivered\s*=\s*true/, /if \(delivered\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import providers_pb2
import providers_pb2_grpc

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)

attempts = 0


def generate(model: str, prompt: str, on_token) -> str:
    # TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
    # DEADLINE_EXCEEDED, fail over to the fallback, open a breaker after 5 failures, and never
    # replay once a token was delivered.
    global attempts
    while True:
        attempts += 1
        try:
            stream = providers.Stream(providers_pb2.StreamRequest(model=model, prompt=prompt))
            parts = []
            for chunk in stream:
                parts.append(chunk.token)
                on_token(chunk.token)
            return "".join(parts)
        except Exception:
            continue
`,
      solution: `import time

import grpc

import providers_pb2
import providers_pb2_grpc

DEADLINE_S = 0.8
MAX_ATTEMPTS = 3
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)
fallback = providers_pb2_grpc.ProviderStub(grpc.insecure_channel("fallback:9000"))


class Breaker:
    """One breaker per provider: open after BREAKER_FAILURES for BREAKER_COOLDOWN_S."""

    def __init__(self) -> None:
        self.failures = 0
        self.opened_at = 0.0

    def allow(self) -> bool:
        if self.failures < BREAKER_FAILURES:
            return True
        if time.monotonic() - self.opened_at < BREAKER_COOLDOWN_S:
            return False
        self.failures = 0
        return True

    def record(self, error: grpc.RpcError | None) -> None:
        if error is None:
            self.failures = 0
        elif error.code() in RETRYABLE:
            self.failures += 1
            if self.failures >= BREAKER_FAILURES:
                self.opened_at = time.monotonic()


breaker = Breaker()


def generate(model: str, prompt: str, on_token) -> str:
    candidates = [(providers, model), (fallback, "small-model")]
    last_error: grpc.RpcError | None = None
    for stub, candidate in candidates:
        if not breaker.allow():
            continue
        for _ in range(MAX_ATTEMPTS):
            delivered = False
            try:
                request = providers_pb2.StreamRequest(model=candidate, prompt=prompt)
                stream = stub.Stream(request, timeout=DEADLINE_S)
                parts = []
                for chunk in stream:
                    delivered = True
                    parts.append(chunk.token)
                    on_token(chunk.token)
                breaker.record(None)
                return "".join(parts)
            except grpc.RpcError as exc:
                breaker.record(exc)
                last_error = exc
                if delivered:
                    raise
                if exc.code() not in RETRYABLE:
                    break
    raise last_error or RuntimeError("all providers unavailable")
`,
    },
    typescript: {
      starter: `/** Provider call: a model-generated draft that retries every failure forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ProviderClient {
  Stream(request: {model: string; prompt: string}): grpc.ClientReadableStream<{token: string}>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const provider = new providers.Provider('providers:9000', grpc.credentials.createInsecure());

export async function generate(model: string, prompt: string, onToken: (token: string) => void): Promise<string> {
  // TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED, fail over to the fallback, open a breaker after 5 failures, and never
  // replay once a token was delivered.
  for (;;) {
    try {
      const parts: string[] = [];
      const stream = provider.Stream({model, prompt});
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: {token: string}) => {
          parts.push(chunk.token);
          onToken(chunk.token);
        });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      return parts.join('');
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** Provider call: 800 ms deadline, three bounded attempts, fallback, breaker, no replay. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 800;
const MAX_ATTEMPTS = 3;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_S = 30;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface ProviderClient {
  Stream(
    request: {model: string; prompt: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): grpc.ClientReadableStream<{token: string}>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const primary = new providers.Provider('providers:9000', grpc.credentials.createInsecure());
const fallback = new providers.Provider('fallback:9000', grpc.credentials.createInsecure());

class Breaker {
  private failures = 0;
  private openedAt = 0;

  allow(): boolean {
    if (this.failures < BREAKER_FAILURES) return true;
    if (Date.now() - this.openedAt < BREAKER_COOLDOWN_S * 1_000) return false;
    this.failures = 0;
    return true;
  }

  record(error: grpc.ServiceError | null): void {
    if (error === null) {
      this.failures = 0;
      return;
    }
    if (RETRYABLE[error.code] === true) {
      this.failures += 1;
      if (this.failures >= BREAKER_FAILURES) this.openedAt = Date.now();
    }
  }
}

const breaker = new Breaker();

export async function generate(model: string, prompt: string, onToken: (token: string) => void): Promise<string> {
  const candidates = [
    {provider: primary, model},
    {provider: fallback, model: 'small-model'},
  ];
  let lastError: grpc.ServiceError | null = null;
  for (const {provider, model: candidate} of candidates) {
    if (!breaker.allow()) continue;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let delivered = false;
      const parts: string[] = [];
      try {
        const stream = provider.Stream(
          {model: candidate, prompt},
          new grpc.Metadata(),
          {deadline: Date.now() + DEADLINE_MS},
        );
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: {token: string}) => {
            delivered = true;
            parts.push(chunk.token);
            onToken(chunk.token);
          });
          stream.on('error', reject);
          stream.on('end', resolve);
        });
        breaker.record(null);
        return parts.join('');
      } catch (error) {
        const serviceError = error as grpc.ServiceError;
        breaker.record(serviceError);
        lastError = serviceError;
        if (delivered) throw serviceError;
        if (RETRYABLE[serviceError.code] !== true) break;
      }
    }
  }
  throw lastError ?? new Error('all providers unavailable');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	pb "router/providerspb"
)

// TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
// DEADLINE_EXCEEDED, fail over to the fallback, open a breaker after 5 failures, and never
// replay once a token was delivered.
func generate(ctx context.Context, client pb.ProviderClient, model, prompt string, onToken func(string)) (string, error) {
	for attempt := 0; ; attempt++ {
		stream, err := client.Stream(ctx, &pb.StreamRequest{Model: model, Prompt: prompt})
		if err != nil {
			continue
		}
		var parts []string
		var chunk *pb.StreamReply
		for chunk, err = stream.Recv(); err == nil; chunk, err = stream.Recv() {
			parts = append(parts, chunk.Token)
			onToken(chunk.Token)
		}
		if err != nil {
			continue
		}
		return strings.Join(parts, ""), nil
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "router/providerspb"
)

const (
	deadlineMS       = 800
	maxAttempts      = 3
	breakerFailures  = 5
	breakerCooldownS = 30
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type breakerState struct {
	failures int
	openedAt time.Time
}

func (b *breakerState) allow() bool {
	if b.failures < breakerFailures {
		return true
	}
	if time.Since(b.openedAt) < breakerCooldownS*time.Second {
		return false
	}
	b.failures = 0
	return true
}

func (b *breakerState) record(err error) {
	if err == nil {
		b.failures = 0
		return
	}
	if st, ok := status.FromError(err); ok && retryable[st.Code()] {
		b.failures++
		if b.failures >= breakerFailures {
			b.openedAt = time.Now()
		}
	}
}

var breaker = &breakerState{}

func streamOnce(
	ctx context.Context,
	client pb.ProviderClient,
	model, prompt string,
	onToken func(string),
) (string, bool, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	stream, err := client.Stream(callCtx, &pb.StreamRequest{Model: model, Prompt: prompt})
	if err != nil {
		return "", false, err
	}
	delivered := false
	var parts []string
	var chunk *pb.StreamReply
	for chunk, err = stream.Recv(); err == nil; chunk, err = stream.Recv() {
		delivered = true
		parts = append(parts, chunk.Token)
		onToken(chunk.Token)
	}
	if errors.Is(err, io.EOF) {
		return strings.Join(parts, ""), delivered, nil
	}
	return "", delivered, err
}

func generate(
	ctx context.Context,
	primary, fallback pb.ProviderClient,
	model, prompt string,
	onToken func(string),
) (string, error) {
	candidates := []struct {
		client pb.ProviderClient
		model  string
	}{{primary, model}, {fallback, "small-model"}}

	var lastErr error
	for _, candidate := range candidates {
		if !breaker.allow() {
			continue
		}
		for attempt := 0; attempt < maxAttempts; attempt++ {
			answer, delivered, err := streamOnce(ctx, candidate.client, candidate.model, prompt, onToken)
			breaker.record(err)
			if err == nil {
				return answer, nil
			}
			lastErr = err
			if delivered {
				return "", err
			}
			if !retryable[status.Code(err)] {
				break
			}
		}
	}
	if lastErr == nil {
		lastErr = errors.New("all providers unavailable")
	}
	return "", lastErr
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object ModelCall {
  val stub = ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build())

  // TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED, fail over to the fallback, open a breaker after 5 failures, and never
  // replay once a token was delivered.
  def generate(model: String, prompt: String, onToken: String => Unit): String = {
    var answer = ""
    var done = false
    while (!done) {
      try {
        val parts = scala.collection.mutable.ArrayBuffer.empty[String]
        stub.stream(StreamRequest(model = model, prompt = prompt)).foreach { chunk =>
          parts += chunk.token
          onToken(chunk.token)
        }
        answer = parts.mkString
        done = true
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    answer
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object ModelCall {
  val DeadlineMs = 800
  val MaxAttempts = 3
  val BreakerFailures = 5
  val BreakerCooldownS = 30
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val primary = ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build())
  val fallback = ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("fallback", 9000).usePlaintext().build())

  class Breaker {
    private var failures = 0
    private var openedAt = 0L

    def allow(): Boolean = {
      if (failures < BreakerFailures) true
      else if (System.currentTimeMillis() - openedAt < BreakerCooldownS * 1000L) false
      else {
        failures = 0
        true
      }
    }

    def record(error: Option[StatusRuntimeException]): Unit = error match {
      case None => failures = 0
      case Some(exc) if Retryable.contains(exc.getStatus.getCode) =>
        failures += 1
        if (failures >= BreakerFailures) openedAt = System.currentTimeMillis()
      case _ => ()
    }
  }

  val breaker = new Breaker

  def generate(model: String, prompt: String, onToken: String => Unit): String = {
    val candidates = List((primary, model), (fallback, "small-model"))
    var lastError: Option[StatusRuntimeException] = None
    for ((stub, candidate) <- candidates) {
      if (breaker.allow()) {
        var attempt = 0
        var stop = false
        while (attempt < MaxAttempts && !stop) {
          var delivered = false
          try {
            val stream = stub
              .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
              .stream(StreamRequest(model = candidate, prompt = prompt))
            val parts = scala.collection.mutable.ArrayBuffer.empty[String]
            stream.foreach { chunk =>
              delivered = true
              parts += chunk.token
              onToken(chunk.token)
            }
            breaker.record(None)
            return parts.mkString
          } catch {
            case exc: StatusRuntimeException =>
              breaker.record(Some(exc))
              lastError = Some(exc)
              if (delivered) throw exc
              if (!Retryable.contains(exc.getStatus.getCode)) stop = true
          }
          attempt += 1
        }
      }
    }
    throw lastError.getOrElse(new RuntimeException("all providers unavailable"))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "providers.grpc.pb.h"

#include <functional>
#include <string>

// TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
// DEADLINE_EXCEEDED, fail over to the fallback, open a breaker after 5 failures, and never
// replay once a token was delivered.
std::string generate(
    Provider::Stub* stub,
    const std::string& model,
    const std::string& prompt,
    const std::function<void(const std::string&)>& on_token) {
  while (true) {
    grpc::ClientContext ctx;
    StreamRequest request;
    request.set_model(model);
    request.set_prompt(prompt);
    auto reader = stub->Stream(&ctx, request);
    StreamReply chunk;
    std::string answer;
    while (reader->Read(&chunk)) {
      answer += chunk.token();
      on_token(chunk.token());
    }
    if (reader->Finish().ok()) return answer;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "providers.grpc.pb.h"

#include <chrono>
#include <functional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

constexpr int kDeadlineMs = 800;
constexpr int kMaxAttempts = 3;
constexpr int kBreakerFailures = 5;
constexpr int kBreakerCooldownS = 30;

class Breaker {
 public:
  bool allow() {
    if (failures_ < kBreakerFailures) return true;
    const auto open_for = std::chrono::steady_clock::now() - opened_at_;
    if (std::chrono::duration_cast<std::chrono::seconds>(open_for).count() < kBreakerCooldownS) return false;
    failures_ = 0;
    return true;
  }

  void record(const grpc::Status& status) {
    if (status.ok()) {
      failures_ = 0;
      return;
    }
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE ||
        status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      failures_ += 1;
      if (failures_ >= kBreakerFailures) opened_at_ = std::chrono::steady_clock::now();
    }
  }

 private:
  int failures_ = 0;
  std::chrono::steady_clock::time_point opened_at_ = std::chrono::steady_clock::now();
};

Breaker breaker;

std::string generate(
    Provider::Stub* primary,
    Provider::Stub* fallback,
    const std::string& model,
    const std::string& prompt,
    const std::function<void(const std::string&)>& on_token) {
  const std::vector<std::pair<Provider::Stub*, std::string>> candidates = {
      {primary, model}, {fallback, "small-model"}};
  grpc::Status last_status;
  for (const auto& [stub, candidate] : candidates) {
    if (!breaker.allow()) continue;
    for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
      bool delivered = false;
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
      StreamRequest request;
      request.set_model(candidate);
      request.set_prompt(prompt);
      auto reader = stub->Stream(&ctx, request);
      StreamReply chunk;
      std::string answer;
      while (reader->Read(&chunk)) {
        delivered = true;
        answer += chunk.token();
        on_token(chunk.token());
      }
      const grpc::Status status = reader->Finish();
      breaker.record(status);
      if (status.ok()) return answer;
      last_status = status;
      if (delivered) throw std::runtime_error("stream failed after the first token: " + status.error_message());
      if (status.error_code() != grpc::StatusCode::UNAVAILABLE &&
          status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED)
        break;
    }
  }
  throw std::runtime_error("all providers unavailable: " + last_status.error_message());
}
`,
    },
  },
  debrief: `The interviewer is probing one question under many names: what is the worst case of this call? A deadline bounds one attempt, max attempts bound the call, the retryable set decides which failures are even worth another attempt, and the breaker bounds the damage to a struggling provider across requests. The fallback is the business continuity answer, and the delivered flag is the correctness answer: streaming is not idempotent, so a retry after the first token duplicates output and usage. The draft looks fine because a healthy provider never enters any of these paths. Real clients add jittered backoff between attempts, per-endpoint concurrency limits, and a half-open breaker that lets one probe request through to test recovery.`,
};
