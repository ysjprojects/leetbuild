import type {Step} from '@/lib/types';

export const providerFailoverStep: Step = {
  id: 'provider-failover',
  title: 'Provider failover: bounded retries, same charge',
  concept: 'grpc',
  file: 'failover',
  focus: ['gateway', 'providers', 'budget'],
  task: `## Task

The starter is a plausible model-generated draft: it passes the happy path on the primary provider,
and when the primary is healthy it streams tokens correctly. The retry path is where it hides its
bugs. Find them, fix them, and prove the fix.

Implement \`stream_with_failover(request, idempotency_key, on_chunk)\` for the gateway’s provider
layer:

- Try the **primary**, then **one fallback**. At most **2** attempts total.
- Each attempt has an **800 ms** deadline. Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable;
  every other status is returned to the caller immediately.
- Send the **same idempotency key** on every attempt (as gRPC metadata) so a retry can never
  double-charge the tenant. Refuse to retry at all when the caller did not supply one.
- Once the first token has been delivered to the client, **never retry**: a replay would duplicate
  output the user already read and bill it twice.
- A circuit breaker at \`circuit:{provider}\` opens after **5** failures for **30 s**; while it is
  open, skip that provider and use the other one.

The failure mode the checks target is the unbounded retry loop that catches every error: one bad
deployment turns into a hot loop against a struggling provider, charges the same request repeatedly,
and never fails over because it only ever calls “primary”.`,
  sequence: {
    participants: ['Gateway', 'Primary', 'Fallback', 'Redis'],
    messages: [
      {from: 'Gateway', to: 'Redis', label: 'GET circuit:primary', kind: 'sync'},
      {from: 'Redis', to: 'Gateway', label: 'absent → closed', kind: 'reply'},
      {from: 'Gateway', to: 'Primary', label: 'StreamComplete · deadline 800 ms · idempotency-key', kind: 'sync'},
      {from: 'Primary', to: 'Gateway', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Gateway', to: 'Redis', label: 'INCR circuit:primary · EX 30', kind: 'sync'},
      {from: 'Gateway', to: 'Fallback', label: 'StreamComplete · same idempotency-key', kind: 'sync'},
      {from: 'Fallback', to: 'Gateway', label: 'tokens', kind: 'async'},
    ],
  },
  hints: [
    'Bound the work with the provider list, not with a counter you hope will stop: two providers, one attempt each, and a `break` once the first token has been yielded. The retry loop from the draft has no exit on a non-retryable error.',
    'The idempotency key belongs in the outgoing metadata of every attempt, and the early return for an empty key must happen before the first call. Same key plus provider-side deduplication is what makes a retry safe; the gateway cannot fix a double charge after the fact.',
    'The breaker is a Redis counter with a TTL: `INCR circuit:{provider}`, set the expiry on the first failure, and when the count reaches five replace the value with `open` and a 30 second expiry. Check it before each attempt, and record only retryable failures — a 400 should not open a circuit.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries an 800 ms deadline',
      detail:
        'The provider call is created with an 800 ms deadline (a call timeout, a context with timeout, `withDeadlineAfter`, or `set_deadline`). Without it a stuck provider holds the request open indefinitely.',
      match: {
        python: {all: [/PER_ATTEMPT_TIMEOUT_S/, /timeout=PER_ATTEMPT_TIMEOUT_S/, /StreamComplete\(/]},
        go: {all: [/context\.WithTimeout\(/, /800\s*\*\s*time\.Millisecond/, /StreamComplete\(/]},
        scala: {all: [/withDeadlineAfter\(/, /TimeUnit\.MILLISECONDS/, /streamComplete\(/]},
        cpp: {all: [/set_deadline\(/, /milliseconds\(800\)/, /StreamComplete\(/]},
        typescript: {
          all: [
            /PER_ATTEMPT_TIMEOUT_MS/,
            /deadline:\s*Date\.now\(\)\s*\+\s*PER_ATTEMPT_TIMEOUT_MS/,
            /StreamComplete\(/,
          ],
        },
      },
    },
    {
      id: 'bounded',
      title: 'At most two attempts, never an unbounded loop',
      detail:
        'The failover is bounded by `MAX_ATTEMPTS = 2` over the primary and fallback providers; there is no `while (true)` or equivalent retry that can spin forever.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /for provider in PROVIDERS/, /PROVIDERS\[:MAX_ATTEMPTS\]/],
          none: [/while\s+True/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2/, /for i, provider := range providers/, /i >= maxAttempts/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*2/, /for \(provider <- Providers/, /attempt < MaxAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*2/, /for \(const auto& provider : kProviders\)/, /attempt\+\+ >= kMaxAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /for \(const provider of PROVIDERS/, /attempt\+\+ >= MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'retryable-and-idempotent',
      title: 'Retries only the two retryable codes, with an idempotency key',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; the call carries `idempotency-key` metadata, refuses to start without one, and stops if a token was already delivered.',
      match: {
        python: {
          all: [
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /idempotency-key/,
            /delivered\s*=\s*True/,
            /if delivered:/,
          ],
        },
        go: {
          all: [
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /idempotency-key/,
            /delivered\s*=\s*true/,
            /if delivered\s*\{/,
          ],
        },
        scala: {
          all: [
            /Code\.UNAVAILABLE/,
            /Code\.DEADLINE_EXCEEDED/,
            /idempotency-key/,
            /delivered\s*=\s*true/,
            /if \(delivered\)/,
          ],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /idempotency-key/,
            /delivered\s*=\s*true/,
            /if \(delivered\)/,
          ],
        },
        typescript: {
          all: [
            /grpc\.status\.UNAVAILABLE/,
            /grpc\.status\.DEADLINE_EXCEEDED/,
            /idempotency-key/,
            /delivered\s*=\s*true/,
            /if \(delivered\)/,
          ],
        },
      },
    },
    {
      id: 'circuit-breaker',
      title: 'Opens circuit:{provider} after five failures for 30 s',
      detail:
        'A Redis key `circuit:{provider}` counts failures, expires after 30 seconds, and is checked before each attempt; five failures replace it with `open` so the gateway stops hammering that provider.',
      match: {
        python: {all: [/circuit:/, /BREAKER_FAILURES|breaker_failures/i, /BREAKER_TTL|breaker_ttl/i, /breaker_open\(/]},
        go: {all: [/circuit:/, /breakerFailures/, /breakerTTL/, /breakerOpen\(/]},
        scala: {all: [/circuit:/, /BreakerFailures/, /BreakerTtl/, /breakerOpen\(/]},
        cpp: {all: [/circuit:/, /kBreakerFailures/, /kBreakerTtl/, /breaker_open\(/]},
        typescript: {all: [/circuit:/, /BREAKER_FAILURES/, /BREAKER_TTL_S/, /breakerOpen\(/]},
      },
    },
    {
      id: 'fallback',
      title: 'Falls back to the second provider',
      detail:
        'After a retryable failure on the primary, the loop moves to the fallback provider instead of retrying the primary forever.',
      match: {
        python: {all: [/primary/, /fallback/, /for provider in PROVIDERS/]},
        go: {all: [/primary/, /fallback/, /for i, provider := range providers/]},
        scala: {all: [/primary/, /fallback/, /for \(provider <- Providers/]},
        cpp: {all: [/primary/, /fallback/, /for \(const auto& provider : kProviders\)/]},
        typescript: {all: [/primary/, /fallback/, /for \(const provider of PROVIDERS/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import providers_pb2_grpc

PROVIDERS = ("primary", "fallback")
MAX_ATTEMPTS = 2
PER_ATTEMPT_TIMEOUT_S = 0.8
BREAKER_FAILURES = 5
BREAKER_TTL_S = 30

stubs = {
    name: providers_pb2_grpc.ProviderStub(grpc.insecure_channel(f"{name}:9000"))
    for name in PROVIDERS
}


class ProviderUnavailable(Exception):
    pass


def stream_with_failover(request, idempotency_key):
    # TODO: bound attempts and use the fallback
    # TODO: set timeout=PER_ATTEMPT_TIMEOUT_S and send idempotency-key metadata
    # TODO: retry only UNAVAILABLE / DEADLINE_EXCEEDED, and never after the first chunk
    # TODO: check and open circuit:{provider} after five failures
    while True:
        try:
            yield from stubs["primary"].StreamComplete(request)
            return
        except grpc.RpcError:
            continue
`,
      solution: `import grpc
import redis

import providers_pb2_grpc

PROVIDERS = ("primary", "fallback")
MAX_ATTEMPTS = 2
PER_ATTEMPT_TIMEOUT_S = 0.8
BREAKER_FAILURES = 5
BREAKER_TTL_S = 30

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stubs = {
    name: providers_pb2_grpc.ProviderStub(grpc.insecure_channel(f"{name}:9000"))
    for name in PROVIDERS
}


class ProviderUnavailable(Exception):
    pass


def breaker_open(provider: str) -> bool:
    return r.get(f"circuit:{provider}") == "open"


def note_failure(provider: str) -> None:
    key = f"circuit:{provider}"
    failures = r.incr(key)
    if failures == 1:
        r.expire(key, BREAKER_TTL_S)
    if failures >= BREAKER_FAILURES:
        r.set(key, "open", ex=BREAKER_TTL_S)


def stream_with_failover(request, idempotency_key):
    if not idempotency_key:
        raise ValueError("idempotency key required")
    for provider in PROVIDERS[:MAX_ATTEMPTS]:
        if breaker_open(provider):
            continue
        delivered = False
        try:
            call = stubs[provider].StreamComplete(
                request,
                timeout=PER_ATTEMPT_TIMEOUT_S,
                metadata=(("idempotency-key", idempotency_key),),
            )
            for chunk in call:
                delivered = True
                yield chunk
            return
        except grpc.RpcError as exc:
            if delivered:
                raise
            if exc.code() not in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED):
                raise
            note_failure(provider)
    raise ProviderUnavailable("primary and fallback failed")
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"io"

	pb "gateway/providerspb"
)

var (
	providers = []string{"primary", "fallback"}
	stubs     = map[string]pb.ProviderClient{}
)

func streamWithFailover(ctx context.Context, req *pb.StreamRequest, idempotencyKey string, onChunk func(*pb.StreamReply) error) error {
	// TODO: bound attempts and use the fallback
	// TODO: context.WithTimeout(800ms) and idempotency-key metadata
	// TODO: retry only Unavailable / DeadlineExceeded, never after a chunk
	// TODO: circuit:{provider} opens after five failures for 30s
	for attempt := 0; ; attempt++ {
		stream, err := stubs["primary"].StreamComplete(ctx, req)
		if err == nil {
			for {
				chunk, recvErr := stream.Recv()
				if recvErr == io.EOF {
					return nil
				}
				if recvErr != nil {
					break
				}
				_ = onChunk(chunk)
			}
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/redis/go-redis/v9"
	pb "gateway/providerspb"
)

const maxAttempts = 2

var (
	providers      = []string{"primary", "fallback"}
	stubs          = map[string]pb.ProviderClient{}
	rdb            *redis.Client
	breakerFailures int64 = 5
	breakerTTL            = 30 * time.Second
)

func breakerOpen(ctx context.Context, provider string) bool {
	return rdb.Get(ctx, "circuit:"+provider).Val() == "open"
}

func noteFailure(ctx context.Context, provider string) {
	key := "circuit:" + provider
	failures, _ := rdb.Incr(ctx, key).Result()
	if failures == 1 {
		rdb.Expire(ctx, key, breakerTTL)
	}
	if failures >= breakerFailures {
		rdb.Set(ctx, key, "open", breakerTTL)
	}
}

func streamWithFailover(ctx context.Context, req *pb.StreamRequest, idempotencyKey string, onChunk func(*pb.StreamReply) error) error {
	if idempotencyKey == "" {
		return errors.New("idempotency key required")
	}
	for i, provider := range providers {
		if i >= maxAttempts {
			break
		}
		if breakerOpen(ctx, provider) {
			continue
		}
		attemptCtx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
		stream, err := stubs[provider].StreamComplete(
			metadata.AppendToOutgoingContext(attemptCtx, "idempotency-key", idempotencyKey), req)
		delivered := false
		if err == nil {
			for {
				chunk, recvErr := stream.Recv()
				if recvErr == io.EOF {
					cancel()
					return nil
				}
				if recvErr != nil {
					err = recvErr
					break
				}
				delivered = true
				if cbErr := onChunk(chunk); cbErr != nil {
					cancel()
					return cbErr
				}
			}
		}
		cancel()
		if delivered {
			return err
		}
		if status.Code(err) != codes.Unavailable && status.Code(err) != codes.DeadlineExceeded {
			return err
		}
		noteFailure(ctx, provider)
	}
	return errors.New("all providers failed")
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.Jedis
import providers.{ProviderGrpc, StreamReply, StreamRequest}

object Failover {
  val Providers = Seq("primary", "fallback")
  val MaxAttempts = 2
  val PerAttemptMillis = 800L
  val BreakerFailures = 5L
  val BreakerTtlSeconds = 30L

  val jedis = new Jedis("redis", 6379)
  val stubs = Providers.map(p => p -> ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress(p, 9000).usePlaintext().build())).toMap

  def streamWithFailover(req: StreamRequest, idempotencyKey: String, onChunk: StreamReply => Unit): Unit = {
    // TODO: bound attempts and use the fallback
    // TODO: withDeadlineAfter(800, MILLISECONDS) and idempotency-key metadata
    // TODO: retry only UNAVAILABLE / DEADLINE_EXCEEDED, and never after a chunk
    // TODO: circuit:{provider} opens after five failures for 30s
    while (true) {
      try {
        stubs("primary").streamComplete(req).foreach(onChunk)
        return
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, StatusCode, StatusRuntimeException}
import redis.clients.jedis.Jedis
import providers.{ProviderGrpc, StreamReply, StreamRequest}

object Failover {
  val Providers = Seq("primary", "fallback")
  val MaxAttempts = 2
  val PerAttemptMillis = 800L
  val BreakerFailures = 5L
  val BreakerTtlSeconds = 30L

  val jedis = new Jedis("redis", 6379)
  val stubs = Providers.map(p => p -> ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress(p, 9000).usePlaintext().build())).toMap

  def breakerOpen(provider: String): Boolean =
    Option(jedis.get("circuit:" + provider)).contains("open")

  def noteFailure(provider: String): Unit = {
    val key = "circuit:" + provider
    val failures = jedis.incr(key)
    if (failures == 1L) jedis.expire(key, BreakerTtlSeconds)
    if (failures >= BreakerFailures) jedis.setex(key, BreakerTtlSeconds, "open")
  }

  def streamWithFailover(req: StreamRequest, idempotencyKey: String, onChunk: StreamReply => Unit): Unit = {
    require(idempotencyKey.nonEmpty, "idempotency key required")
    var attempt = 0
    var delivered = false
    for (provider <- Providers if attempt < MaxAttempts) {
      attempt += 1
      if (!breakerOpen(provider)) {
        try {
          val metadata = new Metadata()
          metadata.put(Metadata.Key.of("idempotency-key", Metadata.ASCII_STRING_MARSHALLER), idempotencyKey)
          val call = MetadataUtils.attachHeaders(
            stubs(provider).withDeadlineAfter(PerAttemptMillis, TimeUnit.MILLISECONDS),
            metadata
          )
          call.streamComplete(req).foreach { chunk =>
            delivered = true
            onChunk(chunk)
          }
          return
        } catch {
          case e: StatusRuntimeException =>
            if (delivered) throw e
            if (e.getStatus.getCode != StatusCode.UNAVAILABLE && e.getStatus.getCode != StatusCode.DEADLINE_EXCEEDED) throw e
            noteFailure(provider)
        }
      }
    }
    throw new RuntimeException("all providers failed")
  }
}
`,
    },
    cpp: {
      starter: `#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <grpcpp/grpcpp.h>

#include "providers.grpc.pb.h"

const std::vector<std::string> kProviders = {"primary", "fallback"};
constexpr int kMaxAttempts = 2;
constexpr auto kPerAttempt = std::chrono::milliseconds(800);
constexpr int kBreakerFailures = 5;
constexpr int kBreakerTtlSeconds = 30;

std::map<std::string, std::unique_ptr<Provider::Stub>> stubs;

int stream_with_failover(const StreamRequest& req, const std::string& idempotency_key,
                         const std::function<void(const StreamReply&)>& on_chunk) {
  // TODO: bound attempts and use the fallback
  // TODO: set_deadline(800ms) and add idempotency-key metadata
  // TODO: retry only UNAVAILABLE / DEADLINE_EXCEEDED, never after a chunk
  // TODO: circuit:{provider} opens after five failures for 30s
  while (true) {
    grpc::ClientContext context;
    auto reader = stubs.at("primary")->StreamComplete(&context, req);
    StreamReply chunk;
    while (reader->Read(&chunk)) on_chunk(chunk);
    const grpc::Status status = reader->Finish();
    if (status.ok()) return 0;
  }
}
`,
      solution: `#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "providers.grpc.pb.h"

const std::vector<std::string> kProviders = {"primary", "fallback"};
constexpr int kMaxAttempts = 2;
constexpr auto kPerAttempt = std::chrono::milliseconds(800);
constexpr int kBreakerFailures = 5;
constexpr int kBreakerTtlSeconds = 30;

std::map<std::string, std::unique_ptr<Provider::Stub>> stubs;
sw::redis::Redis redis("tcp://redis:6379");

bool breaker_open(const std::string& provider) {
  auto value = redis.get("circuit:" + provider);
  return value && *value == "open";
}

void note_failure(const std::string& provider) {
  const std::string key = "circuit:" + provider;
  const long long failures = redis.incr(key);
  if (failures == 1) redis.expire(key, kBreakerTtlSeconds);
  if (failures >= kBreakerFailures) redis.setex(key, kBreakerTtlSeconds, "open");
}

int stream_with_failover(const StreamRequest& req, const std::string& idempotency_key,
                         const std::function<void(const StreamReply&)>& on_chunk) {
  if (idempotency_key.empty()) throw std::invalid_argument("idempotency key required");
  int attempt = 0;
  for (const auto& provider : kProviders) {
    if (attempt++ >= kMaxAttempts) break;
    if (breaker_open(provider)) continue;
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + kPerAttempt);
    context.AddMetadata("idempotency-key", idempotency_key);
    auto reader = stubs.at(provider)->StreamComplete(&context, req);
    bool delivered = false;
    StreamReply chunk;
    while (reader->Read(&chunk)) {
      delivered = true;
      on_chunk(chunk);
    }
    const grpc::Status status = reader->Finish();
    if (status.ok()) return 0;
    if (delivered) throw std::runtime_error(status.error_message());
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE &&
        status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
      throw std::runtime_error(status.error_message());
    }
    note_failure(provider);
  }
  throw std::runtime_error("all providers failed");
}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const PROVIDERS = ['primary', 'fallback'] as const;
const MAX_ATTEMPTS = 2;
const PER_ATTEMPT_TIMEOUT_MS = 800;
const BREAKER_FAILURES = 5;
const BREAKER_TTL_S = 30;
const redis = new Redis({host: 'redis', port: 6379});

interface Message {
  role: string;
  content: string;
}
interface StreamRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface StreamChunk {
  text: string;
}
interface ProviderClient {
  StreamComplete(
    request: StreamRequest,
    metadata: grpc.Metadata,
    options: {deadline: number},
  ): grpc.ClientReadableStream<StreamChunk>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const stubs = Object.fromEntries(
  PROVIDERS.map(name => [name, new providers.Provider(\`\${name}:9000\`, grpc.credentials.createInsecure())]),
) as Record<(typeof PROVIDERS)[number], ProviderClient>;

export async function streamWithFailover(
  request: StreamRequest,
  idempotencyKey: string,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  void idempotencyKey;
  // TODO: bound the attempts over PROVIDERS and move on to the fallback
  // TODO: use PER_ATTEMPT_TIMEOUT_MS as the call deadline and send idempotency-key metadata
  // TODO: retry only UNAVAILABLE and DEADLINE_EXCEEDED, and never after the first chunk
  // TODO: check circuit:{provider} and open it after five failures for 30 s
  while (true) {
    try {
      const call = stubs.primary.StreamComplete(request, new grpc.Metadata(), {});
      for await (const chunk of call) onChunk(chunk);
      return;
    } catch {
      continue;
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const PROVIDERS = ['primary', 'fallback'] as const;
const MAX_ATTEMPTS = 2;
const PER_ATTEMPT_TIMEOUT_MS = 800;
const BREAKER_FAILURES = 5;
const BREAKER_TTL_S = 30;
const redis = new Redis({host: 'redis', port: 6379});

interface Message {
  role: string;
  content: string;
}
interface StreamRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface StreamChunk {
  text: string;
}
interface ProviderClient {
  StreamComplete(
    request: StreamRequest,
    metadata: grpc.Metadata,
    options: {deadline: number},
  ): grpc.ClientReadableStream<StreamChunk>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const stubs = Object.fromEntries(
  PROVIDERS.map(name => [name, new providers.Provider(\`\${name}:9000\`, grpc.credentials.createInsecure())]),
) as Record<(typeof PROVIDERS)[number], ProviderClient>;

async function breakerOpen(provider: string): Promise<boolean> {
  const state = await redis.get(\`circuit:\${provider}\`);
  return state === 'open';
}

async function noteFailure(provider: string): Promise<void> {
  const key = \`circuit:\${provider}\`;
  const failures = await redis.incr(key);
  if (failures === 1) await redis.expire(key, BREAKER_TTL_S);
  if (failures >= BREAKER_FAILURES) await redis.set(key, 'open', 'EX', BREAKER_TTL_S);
}

export async function streamWithFailover(
  request: StreamRequest,
  idempotencyKey: string,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  if (idempotencyKey === '') throw new Error('idempotency key required');
  let attempt = 0;
  for (const provider of PROVIDERS) {
    if (attempt++ >= MAX_ATTEMPTS) break;
    if (await breakerOpen(provider)) continue;
    const metadata = new grpc.Metadata();
    metadata.set('idempotency-key', idempotencyKey);
    const call = stubs[provider].StreamComplete(request, metadata, {
      deadline: Date.now() + PER_ATTEMPT_TIMEOUT_MS,
    });
    let delivered = false;
    try {
      for await (const chunk of call) {
        delivered = true;
        onChunk(chunk);
      }
      return;
    } catch (error) {
      if (delivered) throw error;
      const code = (error as grpc.ServiceError).code;
      if (code !== grpc.status.UNAVAILABLE && code !== grpc.status.DEADLINE_EXCEEDED) throw error;
      await noteFailure(provider);
    }
  }
  throw new Error('primary and fallback failed');
}
`,
    },
  },
  debrief: `The interview signal is **retry safety**: can you state, before writing code, which errors are retryable, how many attempts are allowed, and what makes a retry idempotent? The draft answers none of those and looks shorter and simpler for it. The reviewer is checking that you know an unbounded catch-all retry is an outage amplifier, that a deadline must be per attempt rather than one budget for the whole failover, and that a fallback without the same idempotency key is a double-charge waiting to happen. The circuit breaker is the third leg: it protects the provider from the gateway, not just the gateway from the provider. Real gateways add half-open probing, success-based breaker resets, and per-provider concurrency limits.`,
};
