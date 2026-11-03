import type {Step} from '@/lib/types';

// ---- 4. Failover between providers ---------------------------------------------------------------------
export const providerFailoverStep: Step = {
  id: 'provider-failover',
  title: 'Failover: one fallback, bounded, idempotent',
  concept: 'grpc',
  file: 'failover',
  focus: ['gateway', 'providers', 'budget'],
  task: `## Task

**Starting point.** The starter is \`stream_with_failover(request, idempotency_key)\`, the provider
layer the stream route calls: it opens \`StreamComplete\` on \`primary:9000\`, yields every chunk to
the caller, and on any error sleeps \`RETRY_BACKOFF_S\` and tries the primary again. It serves the
demo and hides 5 flaws.

**Failure mode the checks target.** A provider that fails for an hour: the loop calls it until
something kills the process, pays for the same request on every attempt, replays tokens the user
already read, and never tries the fallback that was healthy all along.

- Providers are \`primary:9000\` then \`fallback:9000\`: **one attempt each**, at most 2 in total,
  with the first that streams to completion winning.
- Every attempt carries the **8 s stream deadline** (a gRPC deadline bounds the whole stream).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` move on to the next provider; any other status is
  raised to the caller at once. Once a chunk has been yielded, no failure moves on: a replay would
  duplicate output and bill it twice.
- Every attempt sends the caller's \`idempotency-key\` as gRPC metadata; without a key the call is
  refused before any attempt.
- A breaker per provider at \`circuit:{provider}\`: \`INCR\` on each retryable failure with a 30 s
  expiry; at 5 the value becomes \`open\` for 30 s and that provider is skipped.`,
  sequence: {
    participants: ['gateway', 'Redis', 'primary', 'fallback'],
    messages: [
      {from: 'gateway', to: 'Redis', label: 'GET circuit:primary', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: 'nil (closed)', kind: 'reply'},
      {from: 'gateway', to: 'primary', label: 'StreamComplete · deadline 8 s · idempotency-key: k-1', kind: 'sync'},
      {from: 'primary', to: 'gateway', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'INCR circuit:primary · EXPIRE 30', kind: 'sync'},
      {from: 'gateway', to: 'fallback', label: 'StreamComplete · deadline 8 s · idempotency-key: k-1', kind: 'sync'},
      {from: 'fallback', to: 'gateway', label: 'Chunk … Chunk', kind: 'async'},
    ],
  },
  hints: [
    'With the primary down, one request shows up as dozens of calls on the provider dashboard and the fallback shows none; a user whose stream broke after three sentences sees them again from the top.',
    'The loop has no bound and no exit on a non-retryable status, backs off and dials the same stub, carries no key the provider could deduplicate on, and has no memory of what it already yielded.',
    'Loop over the two providers once each with the 8 s deadline and the key in the metadata; re-raise once a chunk was yielded or the status is not UNAVAILABLE / DEADLINE_EXCEEDED; count the rest in `circuit:{provider}` (INCR, EXPIRE 30, `open` at 5).',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries the 8 s stream deadline',
      detail:
        'Each StreamComplete call is opened with the 8 second deadline (`timeout=`, `deadline:`, a context with timeout, `withDeadlineAfter`, `set_deadline`); a stalled provider then ends in DEADLINE_EXCEEDED and the fallback gets its turn.',
      match: {
        python: {all: [/StreamComplete\([\s\S]{0,300}?timeout\s*=/]},
        typescript: {all: [/StreamComplete\([\s\S]{0,300}?deadline\s*:/]},
        go: {all: [/context\.With(Timeout|Deadline)\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'bounded',
      title: 'At most one attempt per provider, no open-ended loop',
      detail:
        'The attempts are a loop over the provider list; a `while True` / `for {}` retry with a sleep spins until something kills the process.',
      match: {
        python: {all: [/for\s+\w+\s+in\s+PROVIDERS/], none: [/while\s+True/]},
        typescript: {
          all: [/for\s*\(\s*const\s+\w+\s+of\s+PROVIDERS/],
          none: [/for\s*\(\s*;\s*;\s*\)|while\s*\(\s*true\s*\)/],
        },
        go: {all: [/for\s+[\w, ]*:?=?\s*range\s+provider\w*/], none: [/for\s*\{/]},
        scala: {
          all: [/Providers\.(foreach|iterator|view)|for\s*\(\s*\w+\s*<-\s*Providers/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/for\s*\(\s*(const\s+)?auto&?\s+\w+\s*:\s*kProviders/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'retryable-and-idempotent',
      title: 'Moves on only for UNAVAILABLE / DEADLINE_EXCEEDED, with the idempotency key',
      detail:
        'Only the two retryable codes reach the next provider; every attempt carries `idempotency-key` metadata and no call starts without one; a failure after the first chunk is raised, not retried.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /["']idempotency-key["']/, /metadata\s*=/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /['"]idempotency-key['"]/, /Metadata\(\)/]},
        go: {
          all: [
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /"idempotency-key"/,
            /metadata\.(AppendToOutgoingContext|NewOutgoingContext)\(/,
          ],
        },
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /"idempotency-key"/, /Metadata/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /"idempotency-key"/, /AddMetadata\(/]},
      },
    },
    {
      id: 'circuit-breaker',
      title: 'Opens circuit:{provider} after five retryable failures for 30 s',
      detail:
        '`circuit:{provider}` counts retryable failures with INCR and a 30 s expiry; at five it is set to `open` for 30 s and the provider is skipped until it expires.',
      match: {
        python: {all: [/f["']circuit:\{/, /\.incr\(/, /["']open["']/, /\.expire\(|\bex\s*=/]},
        typescript: {all: [/`circuit:\$\{/, /\.incr\(/, /['"]open['"]/, /\.expire\(|['"]EX['"]/]},
        go: {all: [/"circuit:"\s*\+|"circuit:%s"/, /\.Incr\(/, /"open"/, /\.Expire\(/]},
        scala: {all: [/s"circuit:\$/, /\.incr\(/, /"open"/, /\.expire\(|\.setex\(/]},
        cpp: {all: [/"circuit:"\s*\+/, /\.incr\(/, /"open"/, /\.expire\(|\.setex\(/]},
      },
    },
    {
      id: 'fallback',
      title: 'Falls back to the second provider',
      detail:
        'After a retryable failure on `primary` the loop moves to `fallback` instead of dialling the primary again.',
      match: {
        python: {all: [/["']primary["']/, /["']fallback["']/, /for\s+\w+\s+in\s+PROVIDERS/]},
        typescript: {all: [/['"]primary['"]/, /['"]fallback['"]/, /for\s*\(\s*const\s+\w+\s+of\s+PROVIDERS/]},
        go: {all: [/"primary"/, /"fallback"/, /for\s+[\w, ]*:?=?\s*range\s+provider\w*/]},
        scala: {all: [/"primary"/, /"fallback"/, /Providers\.(foreach|iterator|view)|for\s*\(\s*\w+\s*<-\s*Providers/]},
        cpp: {all: [/"primary"/, /"fallback"/, /for\s*\(\s*(const\s+)?auto&?\s+\w+\s*:\s*kProviders/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import providers_pb2_grpc

STREAM_TIMEOUT_S = 8.0
RETRY_BACKOFF_S = 0.2

stubs = {"primary": providers_pb2_grpc.ProviderStub(grpc.insecure_channel("primary:9000"))}


class ProviderUnavailable(Exception):
    pass


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def stream_with_failover(request, idempotency_key: str):
    """Yields the chunks of one completion, trying again after a failure."""
    while True:
        try:
            yield from stubs["primary"].StreamComplete(request)
            return
        except grpc.RpcError:
            time.sleep(RETRY_BACKOFF_S)
`,
      solution: `import time

import grpc
import redis

import providers_pb2_grpc

PROVIDERS = ("primary", "fallback")
STREAM_TIMEOUT_S = 8.0
BREAKER_FAILURES = 5
BREAKER_TTL_S = 30
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stubs = {name: providers_pb2_grpc.ProviderStub(grpc.insecure_channel(f"{name}:9000")) for name in PROVIDERS}


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


def stream_with_failover(request, idempotency_key: str):
    """Yields the chunks of one completion: the primary, then the fallback, one attempt each."""
    if not idempotency_key:
        raise ValueError("idempotency key required")
    for provider in PROVIDERS:
        if breaker_open(provider):
            continue
        delivered = False
        try:
            call = stubs[provider].StreamComplete(
                request, timeout=STREAM_TIMEOUT_S, metadata=(("idempotency-key", idempotency_key),)
            )
            for chunk in call:
                delivered = True
                yield chunk
            return
        except grpc.RpcError as exc:
            if delivered or exc.code() not in RETRYABLE:
                raise  # the user already read part of the answer, or the provider refused the request itself
            note_failure(provider)
    raise ProviderUnavailable("primary and fallback failed")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const STREAM_TIMEOUT_MS = 8_000;
export const RETRY_BACKOFF_MS = 200;

interface CompleteRequest {
  model: string;
  messages: {role: string; content: string}[];
  max_tokens: number;
}
export interface Chunk {
  text: string;
}
type ProviderStub = grpc.Client & {
  StreamComplete(request: CompleteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<Chunk>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const stubs: Record<string, ProviderStub> = {
  primary: new pkg.gateway.Provider('primary:9000', grpc.credentials.createInsecure()) as ProviderStub,
};

export class ProviderUnavailable extends Error {}

/** The chunks of one call as they arrive; throws the call's error once the chunks before it are out. */
async function* chunksOf(call: grpc.ClientReadableStream<Chunk>): AsyncGenerator<Chunk> {
  const queue: Chunk[] = [];
  let done = false;
  let failed: grpc.ServiceError | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  call.on('data', (chunk: Chunk) => {
    queue.push(chunk);
    notify();
  });
  call.on('error', (e: grpc.ServiceError) => {
    failed = e;
    notify();
  });
  call.on('end', () => {
    done = true;
    notify();
  });
  while (!done || queue.length > 0 || failed !== null) {
    if (queue.length > 0) {
      yield queue.shift() as Chunk;
      continue;
    }
    if (failed !== null) throw failed;
    const {promise, resolve} = Promise.withResolvers<void>();
    wake = resolve;
    await promise;
  }
}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
/** The chunks of one completion, trying again after a failure. */
export async function* streamWithFailover(request: CompleteRequest, idempotencyKey: string): AsyncGenerator<Chunk> {
  for (;;) {
    try {
      for await (const chunk of chunksOf(stubs.primary.StreamComplete(request, new grpc.Metadata(), {}))) yield chunk;
      return;
    } catch {
      await sleep(RETRY_BACKOFF_MS);
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

export const PROVIDERS = ['primary', 'fallback'] as const;
export const STREAM_TIMEOUT_MS = 8_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_TTL_S = 30;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface CompleteRequest {
  model: string;
  messages: {role: string; content: string}[];
  max_tokens: number;
}
export interface Chunk {
  text: string;
}
type ProviderStub = grpc.Client & {
  StreamComplete(request: CompleteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<Chunk>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const stubs: Record<string, ProviderStub> = Object.fromEntries(
  PROVIDERS.map(name => [name, new pkg.gateway.Provider(\`\${name}:9000\`, grpc.credentials.createInsecure()) as ProviderStub]),
);
const redis = new Redis({host: 'redis', port: 6379});

export class ProviderUnavailable extends Error {}

/** The chunks of one call as they arrive; throws the call's error once the chunks before it are out. */
async function* chunksOf(call: grpc.ClientReadableStream<Chunk>): AsyncGenerator<Chunk> {
  const queue: Chunk[] = [];
  let done = false;
  let failed: grpc.ServiceError | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  call.on('data', (chunk: Chunk) => {
    queue.push(chunk);
    notify();
  });
  call.on('error', (e: grpc.ServiceError) => {
    failed = e;
    notify();
  });
  call.on('end', () => {
    done = true;
    notify();
  });
  while (!done || queue.length > 0 || failed !== null) {
    if (queue.length > 0) {
      yield queue.shift() as Chunk;
      continue;
    }
    if (failed !== null) throw failed;
    const {promise, resolve} = Promise.withResolvers<void>();
    wake = resolve;
    await promise;
  }
}

async function breakerOpen(provider: string): Promise<boolean> {
  return (await redis.get(\`circuit:\${provider}\`)) === 'open';
}

async function noteFailure(provider: string): Promise<void> {
  const key = \`circuit:\${provider}\`;
  const failures = await redis.incr(key);
  if (failures === 1) await redis.expire(key, BREAKER_TTL_S);
  if (failures >= BREAKER_FAILURES) await redis.set(key, 'open', 'EX', BREAKER_TTL_S);
}

/** The chunks of one completion: the primary, then the fallback, one attempt each. */
export async function* streamWithFailover(request: CompleteRequest, idempotencyKey: string): AsyncGenerator<Chunk> {
  if (idempotencyKey === '') throw new Error('idempotency key required');
  for (const provider of PROVIDERS) {
    if (await breakerOpen(provider)) continue;
    const metadata = new grpc.Metadata();
    metadata.set('idempotency-key', idempotencyKey);
    let delivered = false;
    try {
      const call = stubs[provider].StreamComplete(request, metadata, {deadline: Date.now() + STREAM_TIMEOUT_MS});
      for await (const chunk of chunksOf(call)) {
        delivered = true;
        yield chunk as Chunk;
      }
      return;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (delivered || !RETRYABLE.has(code)) throw e; // the user already read part of the answer, or the provider refused the request itself
      await noteFailure(provider);
    }
  }
  throw new ProviderUnavailable('primary and fallback failed');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "gateway/gen/providers"
)

const (
	streamTimeout = 8 * time.Second
	retryBackoff  = 200 * time.Millisecond
)

var providers = map[string]pb.ProviderClient{"primary": dial("primary:9000")}

func dial(target string) pb.ProviderClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return pb.NewProviderClient(conn)
}

var errProviderUnavailable = errors.New("primary and fallback failed")

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// streamWithFailover hands every chunk of one completion to onChunk, trying again after a failure.
func streamWithFailover(ctx context.Context, req *pb.CompleteRequest, idempotencyKey string, onChunk func(*pb.Chunk)) error {
	for {
		stream, err := providers["primary"].StreamComplete(ctx, req)
		for err == nil {
			var chunk *pb.Chunk
			chunk, err = stream.Recv()
			if err == io.EOF {
				return nil
			}
			if err == nil {
				onChunk(chunk)
			}
		}
		time.Sleep(retryBackoff)
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "gateway/gen/providers"
)

const (
	streamTimeout   = 8 * time.Second
	breakerFailures = 5
	breakerTTL      = 30 * time.Second
)

var providerNames = []string{"primary", "fallback"}
var providers = map[string]pb.ProviderClient{"primary": dial("primary:9000"), "fallback": dial("fallback:9000")}
var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func dial(target string) pb.ProviderClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return pb.NewProviderClient(conn)
}

var errProviderUnavailable = errors.New("primary and fallback failed")
var errNoIdempotencyKey = errors.New("idempotency key required")

func retryable(err error) bool {
	code := status.Code(err)
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func breakerOpen(ctx context.Context, provider string) bool {
	v, _ := rdb.Get(ctx, "circuit:"+provider).Result()
	return v == "open"
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

// streamWithFailover hands every chunk of one completion to onChunk: the primary, then the fallback, one attempt each.
func streamWithFailover(ctx context.Context, req *pb.CompleteRequest, idempotencyKey string, onChunk func(*pb.Chunk)) error {
	if idempotencyKey == "" {
		return errNoIdempotencyKey
	}
	for _, provider := range providerNames {
		if breakerOpen(ctx, provider) {
			continue
		}
		attempt, cancel := context.WithTimeout(ctx, streamTimeout)
		attempt = metadata.AppendToOutgoingContext(attempt, "idempotency-key", idempotencyKey)
		delivered := false
		stream, err := providers[provider].StreamComplete(attempt, req)
		for err == nil {
			var chunk *pb.Chunk
			chunk, err = stream.Recv()
			if err == io.EOF {
				cancel()
				return nil
			}
			if err == nil {
				delivered = true
				onChunk(chunk)
			}
		}
		cancel()
		if delivered || !retryable(err) {
			return err // the user already read part of the answer, or the provider refused the request itself
		}
		noteFailure(ctx, provider)
	}
	return errProviderUnavailable
}
`,
    },
    scala: {
      starter: `import gateway.providers.{Chunk, CompleteRequest, ProviderGrpc}
import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.jdk.CollectionConverters._

object Failover {
  val StreamTimeoutMillis = 8000L
  val RetryBackoffMillis = 200L

  private val stubs = Map("primary" -> ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress("primary", 9000).usePlaintext().build()))

  class ProviderUnavailable extends RuntimeException("primary and fallback failed")

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  /** Hands every chunk of one completion to onChunk, trying again after a failure. */
  def streamWithFailover(request: CompleteRequest, idempotencyKey: String, onChunk: Chunk => Unit): Unit = {
    while (true) {
      try {
        stubs("primary").streamComplete(request).foreach(onChunk)
        return
      } catch {
        case _: StatusRuntimeException => Thread.sleep(RetryBackoffMillis)
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import gateway.providers.{Chunk, CompleteRequest, ProviderGrpc}
import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object Failover {
  val Providers = Seq("primary", "fallback")
  val StreamTimeoutMillis = 8000L
  val BreakerFailures = 5L
  val BreakerTtlSeconds = 30L
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val jedis = new JedisPooled("redis", 6379)
  private val stubs = Providers.map(name => name -> ProviderGrpc.blockingStub(ManagedChannelBuilder.forAddress(name, 9000).usePlaintext().build())).toMap
  private val IdempotencyKey = Metadata.Key.of("idempotency-key", Metadata.ASCII_STRING_MARSHALLER)

  class ProviderUnavailable extends RuntimeException("primary and fallback failed")

  def breakerOpen(provider: String): Boolean = jedis.get(s"circuit:$provider") == "open"

  def noteFailure(provider: String): Unit = {
    val key = s"circuit:$provider"
    val failures = jedis.incr(key)
    if (failures == 1L) jedis.expire(key, BreakerTtlSeconds)
    if (failures >= BreakerFailures) jedis.setex(key, BreakerTtlSeconds, "open")
  }

  /** Hands every chunk of one completion to onChunk: the primary, then the fallback, one attempt each. */
  def streamWithFailover(request: CompleteRequest, idempotencyKey: String, onChunk: Chunk => Unit): Unit = {
    require(idempotencyKey.nonEmpty, "idempotency key required")
    val headers = new Metadata()
    headers.put(IdempotencyKey, idempotencyKey)
    Providers.iterator.filterNot(breakerOpen).foreach { provider =>
      var delivered = false
      try {
        val call = stubs(provider)
          .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
          .withDeadlineAfter(StreamTimeoutMillis, TimeUnit.MILLISECONDS)
        call.streamComplete(request).foreach { chunk =>
          delivered = true
          onChunk(chunk)
        }
        return
      } catch {
        case e: StatusRuntimeException =>
          // The user already read part of the answer, or the provider refused the request itself.
          if (delivered || !Retryable.contains(e.getStatus.getCode)) throw e
          noteFailure(provider)
      }
    }
    throw new ProviderUnavailable
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include "providers.grpc.pb.h"

constexpr std::chrono::seconds kStreamTimeout{8};
constexpr std::chrono::milliseconds kRetryBackoff{200};

std::map<std::string, std::unique_ptr<gateway::Provider::Stub>> make_stubs() {
  std::map<std::string, std::unique_ptr<gateway::Provider::Stub>> stubs;
  stubs["primary"] = gateway::Provider::NewStub(grpc::CreateChannel("primary:9000", grpc::InsecureChannelCredentials()));
  return stubs;
}

auto stubs = make_stubs();

struct ProviderUnavailable : std::runtime_error {
  ProviderUnavailable() : std::runtime_error("primary and fallback failed") {}
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
// Hands every chunk of one completion to on_chunk, trying again after a failure.
void stream_with_failover(const gateway::CompleteRequest& request, const std::string& idempotency_key,
                          const std::function<void(const gateway::Chunk&)>& on_chunk) {
  while (true) {
    grpc::ClientContext ctx;
    auto reader = stubs["primary"]->StreamComplete(&ctx, request);
    gateway::Chunk chunk;
    while (reader->Read(&chunk)) on_chunk(chunk);
    if (reader->Finish().ok()) return;
    std::this_thread::sleep_for(kRetryBackoff);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "providers.grpc.pb.h"

const std::vector<std::string> kProviders = {"primary", "fallback"};
constexpr std::chrono::seconds kStreamTimeout{8};
constexpr long long kBreakerFailures = 5;
constexpr std::chrono::seconds kBreakerTtl{30};

std::map<std::string, std::unique_ptr<gateway::Provider::Stub>> make_stubs() {
  std::map<std::string, std::unique_ptr<gateway::Provider::Stub>> stubs;
  for (const auto& name : kProviders) {
    stubs[name] = gateway::Provider::NewStub(grpc::CreateChannel(name + ":9000", grpc::InsecureChannelCredentials()));
  }
  return stubs;
}

auto stubs = make_stubs();
sw::redis::Redis redis("tcp://redis:6379");

struct ProviderUnavailable : std::runtime_error {
  ProviderUnavailable() : std::runtime_error("primary and fallback failed") {}
};

// A failed attempt as the caller sees it: the status, or the std::invalid_argument of a missing key.
struct ProviderError : std::runtime_error {
  grpc::StatusCode code;
  ProviderError(grpc::StatusCode c, const std::string& what) : std::runtime_error(what), code(c) {}
};

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

bool breaker_open(const std::string& provider) {
  const auto v = redis.get("circuit:" + provider);
  return v && *v == "open";
}

void note_failure(const std::string& provider) {
  const std::string key = "circuit:" + provider;
  const long long failures = redis.incr(key);
  if (failures == 1) redis.expire(key, kBreakerTtl);
  if (failures >= kBreakerFailures) redis.setex(key, kBreakerTtl, "open");
}

// Hands every chunk of one completion to on_chunk: the primary, then the fallback, one attempt each.
void stream_with_failover(const gateway::CompleteRequest& request, const std::string& idempotency_key,
                          const std::function<void(const gateway::Chunk&)>& on_chunk) {
  if (idempotency_key.empty()) throw std::invalid_argument("idempotency key required");
  for (const auto& provider : kProviders) {
    if (breaker_open(provider)) continue;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kStreamTimeout);
    ctx.AddMetadata("idempotency-key", idempotency_key);
    auto reader = stubs[provider]->StreamComplete(&ctx, request);
    bool delivered = false;
    gateway::Chunk chunk;
    while (reader->Read(&chunk)) {
      delivered = true;
      on_chunk(chunk);
    }
    const grpc::Status status = reader->Finish();
    if (status.ok()) return;
    // The user already read part of the answer, or the provider refused the request itself.
    if (delivered || !retryable(status.error_code())) throw ProviderError(status.error_code(), status.error_message());
    note_failure(provider);
  }
  throw ProviderUnavailable();
}
`,
    },
  },
  harness: {
    python: `import grpc

import providers_pb2
import providers_pb2_grpc

TOKENS = ["The", " capital", " of", " France", " is", " Paris", "."]
PRIMARY, FALLBACK = "primary:9000", "fallback:9000"
REQUEST = providers_pb2.CompleteRequest(model="gpt-4o-mini", messages=[providers_pb2.Message(role="user", content="What is the capital of France?")], max_tokens=64)


class Providers(providers_pb2_grpc.ProviderServicer):
    """A model provider: streams the answer; with break_after it fails UNAVAILABLE after that many chunks."""

    def __init__(self, name, break_after=None):
        self.name = name
        self.break_after = break_after

    def StreamComplete(self, request, context):
        for i, t in enumerate(TOKENS):
            if self.break_after is not None and i == self.break_after:
                context.abort(grpc.StatusCode.UNAVAILABLE, f"{self.name} lost its upstream")
            yield providers_pb2.Chunk(text=t)


def _world(ctx, primary_break_after=None):
    ctx.grpc.serve(providers_pb2_grpc.add_ProviderServicer_to_server, Providers("primary", primary_break_after), PRIMARY)
    ctx.grpc.serve(providers_pb2_grpc.add_ProviderServicer_to_server, Providers("fallback"), FALLBACK)
    return ctx.load("failover")


def _run(ctx, m, key="k-1"):
    """One call: the chunk texts it yielded and the exception it ended with; None for both if it never ended."""
    chunks, error = [], None

    def consume():
        nonlocal error
        try:
            for chunk in m.stream_with_failover(REQUEST, key):
                chunks.append(chunk.text)
        except Exception as exc:  # noqa: BLE001 - whatever the call ended with is the outcome
            error = exc
        return True

    ctx.clock.sleep_limit = ctx.clock.sleeps + 200  # a loop that backs off and retries forever is stopped here, as Ctrl-C would
    ended = ctx.drain(consume)
    return chunks, error, bool(ended)


def _calls(ctx, target):
    return ctx.grpc.calls_to("StreamComplete", target)


async def check_deadline(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("StreamComplete", 20.0, PRIMARY)
    chunks, error, ended = _run(ctx, m)
    assert ended, f"with the primary stalled the call never ended ({len(_calls(ctx, PRIMARY))} attempts on it): every attempt needs a deadline"
    primary = _calls(ctx, PRIMARY)
    assert primary and primary[0].timeout is not None, "the StreamComplete call carries no deadline: a stalled provider holds the request open forever"
    assert 7.5 <= primary[0].timeout <= 8.5, f"the deadline must be the 8 s stream deadline, got {primary[0].timeout} s"
    assert error is None and chunks == TOKENS, f"after the primary timed out the fallback must serve the answer; got {chunks} and {error!r}"
    assert len(primary) == 1 and len(_calls(ctx, FALLBACK)) == 1, f"expected one attempt on each provider, got {len(primary)} on primary and {len(_calls(ctx, FALLBACK))} on fallback"


async def check_bounded(ctx):
    m = _world(ctx)
    ctx.grpc.stop(PRIMARY)
    ctx.grpc.stop(FALLBACK)
    chunks, error, ended = _run(ctx, m)
    total = len(_calls(ctx, PRIMARY)) + len(_calls(ctx, FALLBACK))
    assert ended, f"with both providers down the call never ended: {total} attempts and counting. Bound the attempts by the provider list"
    assert error is not None, "with both providers down the call must end with an error, it returned normally"
    assert total <= 2, f"with both providers down the call made {total} attempts, expected at most 2 (one per provider)"


async def check_retryable_and_idempotent(ctx):
    m = _world(ctx)
    ctx.grpc.fail("StreamComplete", grpc.StatusCode.INVALID_ARGUMENT, "bad request", times=1, target=PRIMARY)
    chunks, error, ended = _run(ctx, m)
    assert ended and error is not None, "INVALID_ARGUMENT from the primary must be raised to the caller at once"
    assert len(_calls(ctx, FALLBACK)) == 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried (the request itself is wrong)"
    assert ctx.redis.get("circuit:primary") != "open", "a non-retryable failure must not count towards the breaker"
    chunks, error, ended = _run(ctx, m, key="k-7")
    assert error is None and chunks == TOKENS, f"a healthy primary must serve the answer, got {chunks} and {error!r}"
    md = dict((str(k), v) for k, v in _calls(ctx, PRIMARY)[-1].metadata)
    assert md.get("idempotency-key") == "k-7", f"the attempt carried metadata {md}, expected idempotency-key: k-7"
    before = len(_calls(ctx, PRIMARY))
    chunks, error, ended = _run(ctx, m, key="")
    assert error is not None and len(_calls(ctx, PRIMARY)) == before, "without an idempotency key the call must be refused before any attempt"
    m = _world(ctx, primary_break_after=2)
    chunks, error, ended = _run(ctx, m, key="k-9")
    assert chunks == TOKENS[:2], f"the caller must receive the two chunks the primary streamed before failing, got {chunks}"
    assert error is not None, "a failure after the first chunk must be raised: a retry would replay output the user already read"
    assert len(_calls(ctx, FALLBACK)) == 0, "after a chunk was delivered the fallback must not be tried: it would replay and bill the answer twice"


async def check_circuit_breaker(ctx):
    m = _world(ctx)
    for i in range(5):
        ctx.grpc.fail("StreamComplete", grpc.StatusCode.UNAVAILABLE, "primary restarting", times=1, target=PRIMARY)
        chunks, error, ended = _run(ctx, m, key=f"k-{i}")
        assert error is None and chunks == TOKENS, f"attempt {i + 1}: the fallback must serve the answer while the primary fails, got {chunks} and {error!r}"
    state = ctx.redis.get("circuit:primary")
    assert state == "open", f"after five retryable failures circuit:primary is {state!r}, expected 'open'"
    ttl = ctx.redis.ttl("circuit:primary")
    assert 0 < ttl <= 30, f"circuit:primary must expire within 30 s, its TTL is {ttl}"
    before = len(_calls(ctx, PRIMARY))
    chunks, error, ended = _run(ctx, m, key="k-open")
    assert len(_calls(ctx, PRIMARY)) == before, "while the breaker is open the primary must be skipped"
    assert error is None and chunks == TOKENS, "while the breaker is open the fallback serves the answer"
    ctx.clock.advance(31)
    chunks, error, ended = _run(ctx, m, key="k-closed")
    assert len(_calls(ctx, PRIMARY)) == before + 1, "once the breaker has expired the primary gets its turn again"


async def check_fallback(ctx):
    m = _world(ctx)
    ctx.grpc.stop(PRIMARY)
    chunks, error, ended = _run(ctx, m)
    assert ended, "with the primary down the call never ended: dial the fallback instead of the primary again"
    assert error is None and chunks == TOKENS, f"with the primary down the fallback must serve the whole answer, got {chunks} and {error!r}"
    assert len(_calls(ctx, PRIMARY)) == 1, f"the primary was dialled {len(_calls(ctx, PRIMARY))} times, expected once"
    assert len(_calls(ctx, FALLBACK)) == 1, f"the fallback was dialled {len(_calls(ctx, FALLBACK))} times, expected once"
`,
    typescript: `const TOKENS = ['The', ' capital', ' of', ' France', ' is', ' Paris', '.'];
const PRIMARY = 'primary:9000';
const FALLBACK = 'fallback:9000';
const REQUEST = {model: 'gpt-4o-mini', messages: [{role: 'user', content: 'What is the capital of France?'}], max_tokens: 64};

/** A model provider: streams the answer; with breakAfter it fails UNAVAILABLE after that many chunks. */
function provider(ctx, name: string, breakAfter: number | null = null) {
  return {
    StreamComplete(call) {
      for (const [i, t] of TOKENS.entries()) {
        if (breakAfter !== null && i === breakAfter) {
          call.emit('error', Object.assign(new Error(\`\${name} lost its upstream\`), {code: ctx.grpc.status.UNAVAILABLE}));
          return;
        }
        call.write({text: t});
      }
      call.end();
    },
  };
}

function world(ctx, primaryBreakAfter: number | null = null) {
  const pkg = ctx.proto('providers.proto');
  ctx.grpc.serve(pkg.gateway.Provider.service, provider(ctx, 'primary', primaryBreakAfter), PRIMARY);
  ctx.grpc.serve(pkg.gateway.Provider.service, provider(ctx, 'fallback'), FALLBACK);
  return ctx.load('failover');
}

/** One call: the chunk texts it yielded and the error it ended with; ended is false if it never did. */
async function run(ctx, m, key = 'k-1') {
  const chunks: string[] = [];
  let error: unknown = null;
  const consume = async () => {
    try {
      for await (const chunk of m.streamWithFailover(REQUEST, key)) chunks.push(chunk.text);
    } catch (e) {
      error = e;
    }
    return true;
  };
  const ended = await ctx.drain(consume());
  return {chunks, error, ended: ended === true};
}

const calls = (ctx, target: string) => ctx.grpc.callsTo('StreamComplete', target);

export async function check_deadline(ctx) {
  const m = world(ctx);
  ctx.grpc.setLatency('StreamComplete', 20.0, PRIMARY);
  const {chunks, error, ended} = await run(ctx, m);
  assert(ended, \`with the primary stalled the call never ended (\${calls(ctx, PRIMARY).length} attempts on it): every attempt needs a deadline\`);
  const primary = calls(ctx, PRIMARY);
  assert(primary.length > 0 && primary[0].timeout !== null, 'the StreamComplete call carries no deadline: a stalled provider holds the request open forever');
  assert(7.5 <= primary[0].timeout && primary[0].timeout <= 8.5, \`the deadline must be the 8 s stream deadline, got \${primary[0].timeout} s\`);
  assert(error === null, \`after the primary timed out the fallback must serve the answer; the call failed with \${error}\`);
  assert.deepStrictEqual(chunks, TOKENS, \`after the primary timed out the fallback must serve the answer; got \${JSON.stringify(chunks)}\`);
  assert(primary.length === 1 && calls(ctx, FALLBACK).length === 1, \`expected one attempt on each provider, got \${primary.length} on primary and \${calls(ctx, FALLBACK).length} on fallback\`);
}

export async function check_bounded(ctx) {
  const m = world(ctx);
  ctx.grpc.stop(PRIMARY);
  ctx.grpc.stop(FALLBACK);
  const {error, ended} = await run(ctx, m);
  const total = calls(ctx, PRIMARY).length + calls(ctx, FALLBACK).length;
  assert(ended, \`with both providers down the call never ended: \${total} attempts and counting. Bound the attempts by the provider list\`);
  assert(error !== null, 'with both providers down the call must end with an error, it returned normally');
  assert(total <= 2, \`with both providers down the call made \${total} attempts, expected at most 2 (one per provider)\`);
}

export async function check_retryable_and_idempotent(ctx) {
  let m = world(ctx);
  ctx.grpc.fail('StreamComplete', ctx.grpc.status.INVALID_ARGUMENT, 'bad request', 1, PRIMARY);
  let out = await run(ctx, m);
  assert(out.ended && out.error !== null, 'INVALID_ARGUMENT from the primary must be raised to the caller at once');
  assert.equal(calls(ctx, FALLBACK).length, 0, 'INVALID_ARGUMENT is not retryable: the fallback must not be tried (the request itself is wrong)');
  assert.notEqual(ctx.redis.get('circuit:primary'), 'open', 'a non-retryable failure must not count towards the breaker');
  out = await run(ctx, m, 'k-7');
  assert(out.error === null, \`a healthy primary must serve the answer, the call failed with \${out.error}\`);
  assert.deepStrictEqual(out.chunks, TOKENS, \`a healthy primary must serve the answer, got \${JSON.stringify(out.chunks)}\`);
  const md = calls(ctx, PRIMARY).at(-1).metadata.getMap();
  assert.equal(md['idempotency-key'], 'k-7', \`the attempt carried metadata \${JSON.stringify(md)}, expected idempotency-key: k-7\`);
  const before = calls(ctx, PRIMARY).length;
  out = await run(ctx, m, '');
  assert(out.error !== null && calls(ctx, PRIMARY).length === before, 'without an idempotency key the call must be refused before any attempt');
  m = world(ctx, 2);
  out = await run(ctx, m, 'k-9');
  assert.deepStrictEqual(out.chunks, TOKENS.slice(0, 2), \`the caller must receive the two chunks the primary streamed before failing, got \${JSON.stringify(out.chunks)}\`);
  assert(out.error !== null, 'a failure after the first chunk must be raised: a retry would replay output the user already read');
  assert.equal(calls(ctx, FALLBACK).length, 0, 'after a chunk was delivered the fallback must not be tried: it would replay and bill the answer twice');
}

export async function check_circuit_breaker(ctx) {
  const m = world(ctx);
  for (let i = 0; i < 5; i += 1) {
    ctx.grpc.fail('StreamComplete', ctx.grpc.status.UNAVAILABLE, 'primary restarting', 1, PRIMARY);
    const out = await run(ctx, m, \`k-\${i}\`);
    assert(out.error === null, \`attempt \${i + 1}: the fallback must serve the answer while the primary fails, the call failed with \${out.error}\`);
    assert.deepStrictEqual(out.chunks, TOKENS, \`attempt \${i + 1}: the fallback must serve the answer while the primary fails, got \${JSON.stringify(out.chunks)}\`);
  }
  const state = ctx.redis.get('circuit:primary');
  assert.equal(state, 'open', \`after five retryable failures circuit:primary is \${JSON.stringify(state)}, expected 'open'\`);
  const ttl = Number(ctx.redis.ttl('circuit:primary'));
  assert(0 < ttl && ttl <= 30, \`circuit:primary must expire within 30 s, its TTL is \${ttl}\`);
  const before = calls(ctx, PRIMARY).length;
  let out = await run(ctx, m, 'k-open');
  assert.equal(calls(ctx, PRIMARY).length, before, 'while the breaker is open the primary must be skipped');
  assert(out.error === null && out.chunks.length === TOKENS.length, 'while the breaker is open the fallback serves the answer');
  ctx.clock.advance(31);
  out = await run(ctx, m, 'k-closed');
  assert.equal(calls(ctx, PRIMARY).length, before + 1, 'once the breaker has expired the primary gets its turn again');
}

export async function check_fallback(ctx) {
  const m = world(ctx);
  ctx.grpc.stop(PRIMARY);
  const {chunks, error, ended} = await run(ctx, m);
  assert(ended, 'with the primary down the call never ended: dial the fallback instead of the primary again');
  assert(error === null, \`with the primary down the fallback must serve the whole answer, the call failed with \${error}\`);
  assert.deepStrictEqual(chunks, TOKENS, \`with the primary down the fallback must serve the whole answer, got \${JSON.stringify(chunks)}\`);
  assert.equal(calls(ctx, PRIMARY).length, 1, \`the primary was dialled \${calls(ctx, PRIMARY).length} times, expected once\`);
  assert.equal(calls(ctx, FALLBACK).length, 1, \`the fallback was dialled \${calls(ctx, FALLBACK).length} times, expected once\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "gateway/gen/providers"
)

var failoverTokens = []string{"The", " capital", " of", " France", " is", " Paris", "."}

const (
	failoverPrimary  = "primary:9000"
	failoverFallback = "fallback:9000"
)

var failoverRequest = &pb.CompleteRequest{Model: "gpt-4o-mini", Messages: []*pb.Message{{Role: "user", Content: "What is the capital of France?"}}, MaxTokens: 64}

// failoverPeer is a model provider: streams the answer; with breakAfter >= 0 it fails UNAVAILABLE after that many chunks.
type failoverPeer struct {
	pb.UnimplementedProviderServer
	name       string
	breakAfter int
}

func (p *failoverPeer) StreamComplete(_ *pb.CompleteRequest, srv pb.Provider_StreamCompleteServer) error {
	for i, t := range failoverTokens {
		if p.breakAfter >= 0 && i == p.breakAfter {
			return status.Error(codes.Unavailable, p.name+" lost its upstream")
		}
		if err := srv.Send(&pb.Chunk{Text: t}); err != nil {
			return err
		}
	}
	return nil
}

func failoverWorld(ctx *harness.Ctx, primaryBreakAfter int) {
	pb.RegisterProviderServer(ctx.GRPC.Server(failoverPrimary), &failoverPeer{name: "primary", breakAfter: primaryBreakAfter})
	pb.RegisterProviderServer(ctx.GRPC.Server(failoverFallback), &failoverPeer{name: "fallback", breakAfter: -1})
}

type failoverOut struct {
	chunks []string
	err    error
	ended  bool
}

// failoverRun is one call: the chunk texts it handed over and the error it ended with; ended is false if it never did.
func failoverRun(ctx *harness.Ctx, key string) failoverOut {
	out := failoverOut{chunks: []string{}}
	out.ended = ctx.Drain(func() {
		out.err = streamWithFailover(context.Background(), failoverRequest, key, func(c *pb.Chunk) { out.chunks = append(out.chunks, c.GetText()) })
	})
	return out
}

func failoverCalls(ctx *harness.Ctx, target string) []harness.Call {
	return ctx.GRPC.CallsTo("StreamComplete", target)
}

func CheckDeadline(ctx *harness.Ctx) {
	failoverWorld(ctx, -1)
	ctx.GRPC.SetLatency("StreamComplete", 20.0, failoverPrimary)
	out := failoverRun(ctx, "k-1")
	ctx.Assert(out.ended, "with the primary stalled the call never ended (%d attempts on it): every attempt needs a deadline", len(failoverCalls(ctx, failoverPrimary)))
	primary := failoverCalls(ctx, failoverPrimary)
	ctx.Assert(len(primary) > 0 && primary[0].HasDeadline(), "the StreamComplete call carries no deadline: a stalled provider holds the request open forever")
	ctx.Assert(7500*time.Millisecond <= primary[0].Timeout && primary[0].Timeout <= 8500*time.Millisecond, "the deadline must be the 8 s stream deadline, got %v", primary[0].Timeout)
	ctx.NoError(out.err, "after the primary timed out the fallback must serve the answer")
	ctx.Equal(out.chunks, failoverTokens, "after the primary timed out the fallback must serve the answer")
	ctx.Assert(len(primary) == 1 && len(failoverCalls(ctx, failoverFallback)) == 1, "expected one attempt on each provider, got %d on primary and %d on fallback", len(primary), len(failoverCalls(ctx, failoverFallback)))
}

func CheckBounded(ctx *harness.Ctx) {
	failoverWorld(ctx, -1)
	ctx.GRPC.Stop(failoverPrimary)
	ctx.GRPC.Stop(failoverFallback)
	out := failoverRun(ctx, "k-1")
	total := len(failoverCalls(ctx, failoverPrimary)) + len(failoverCalls(ctx, failoverFallback))
	ctx.Assert(out.ended, "with both providers down the call never ended: %d attempts and counting. Bound the attempts by the provider list", total)
	ctx.Assert(out.err != nil, "with both providers down the call must end with an error, it returned nil")
	ctx.Assert(total <= 2, "with both providers down the call made %d attempts, expected at most 2 (one per provider)", total)
}

func CheckRetryableAndIdempotent(ctx *harness.Ctx) {
	failoverWorld(ctx, -1)
	ctx.GRPC.Fail("StreamComplete", codes.InvalidArgument, "bad request", 1, failoverPrimary)
	out := failoverRun(ctx, "k-1")
	ctx.Assert(out.ended && out.err != nil, "INVALID_ARGUMENT from the primary must be returned to the caller at once")
	ctx.Equal(len(failoverCalls(ctx, failoverFallback)), 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried (the request itself is wrong); fallback attempts")
	state, _ := ctx.Redis.Get("circuit:primary")
	ctx.Assert(state != "open", "a non-retryable failure must not count towards the breaker")
	out = failoverRun(ctx, "k-7")
	ctx.NoError(out.err, "a healthy primary must serve the answer")
	ctx.Equal(out.chunks, failoverTokens, "a healthy primary must serve the answer")
	calls := failoverCalls(ctx, failoverPrimary)
	md := calls[len(calls)-1].Metadata
	ctx.Equal(md.Get("idempotency-key"), []string{"k-7"}, "the attempt carried metadata %v; idempotency-key", md)
	before := len(failoverCalls(ctx, failoverPrimary))
	out = failoverRun(ctx, "")
	ctx.Assert(out.err != nil && len(failoverCalls(ctx, failoverPrimary)) == before, "without an idempotency key the call must be refused before any attempt")
	ctx.GRPC.Stop(failoverPrimary)
	pb.RegisterProviderServer(ctx.GRPC.Server(failoverPrimary), &failoverPeer{name: "primary", breakAfter: 2})
	out = failoverRun(ctx, "k-9")
	ctx.Equal(out.chunks, failoverTokens[:2], "the caller must receive the two chunks the primary streamed before failing")
	ctx.Assert(out.err != nil, "a failure after the first chunk must be returned: a retry would replay output the user already read")
	ctx.Equal(len(failoverCalls(ctx, failoverFallback)), 0, "after a chunk was delivered the fallback must not be tried (it would replay and bill the answer twice); fallback attempts")
}

func CheckCircuitBreaker(ctx *harness.Ctx) {
	failoverWorld(ctx, -1)
	for i := range 5 {
		ctx.GRPC.Fail("StreamComplete", codes.Unavailable, "primary restarting", 1, failoverPrimary)
		out := failoverRun(ctx, "k-"+string(rune('0'+i)))
		ctx.NoError(out.err, "attempt %d: the fallback must serve the answer while the primary fails", i+1)
		ctx.Equal(out.chunks, failoverTokens, "attempt %d: the fallback must serve the answer while the primary fails", i+1)
	}
	state, _ := ctx.Redis.Get("circuit:primary")
	ctx.Equal(state, "open", "after five retryable failures circuit:primary")
	ttl := ctx.Redis.TTL("circuit:primary")
	ctx.Assert(0 < ttl && ttl <= 30, "circuit:primary must expire within 30 s, its TTL is %d", ttl)
	before := len(failoverCalls(ctx, failoverPrimary))
	out := failoverRun(ctx, "k-open")
	ctx.Equal(len(failoverCalls(ctx, failoverPrimary)), before, "while the breaker is open the primary must be skipped; primary attempts")
	ctx.Assert(out.err == nil && len(out.chunks) == len(failoverTokens), "while the breaker is open the fallback serves the answer")
	ctx.Clock.Advance(31)
	out = failoverRun(ctx, "k-closed")
	ctx.Equal(len(failoverCalls(ctx, failoverPrimary)), before+1, "once the breaker has expired the primary gets its turn again; primary attempts")
}

func CheckFallback(ctx *harness.Ctx) {
	failoverWorld(ctx, -1)
	ctx.GRPC.Stop(failoverPrimary)
	out := failoverRun(ctx, "k-1")
	ctx.Assert(out.ended, "with the primary down the call never ended: dial the fallback instead of the primary again")
	ctx.NoError(out.err, "with the primary down the fallback must serve the whole answer")
	ctx.Equal(out.chunks, failoverTokens, "with the primary down the fallback must serve the whole answer")
	ctx.Equal(len(failoverCalls(ctx, failoverPrimary)), 1, "the primary must be dialled once; primary attempts")
	ctx.Equal(len(failoverCalls(ctx, failoverFallback)), 1, "the fallback must be dialled once; fallback attempts")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <string>
#include <vector>

namespace {

const std::vector<std::string> kFailoverTokens = {"The", " capital", " of", " France", " is", " Paris", "."};
const std::string kPrimary = "primary:9000";
const std::string kFallback = "fallback:9000";

gateway::CompleteRequest failoverRequest() {
  gateway::CompleteRequest req;
  req.set_model("gpt-4o-mini");
  auto* m = req.add_messages();
  m->set_role("user");
  m->set_content("What is the capital of France?");
  req.set_max_tokens(64);
  return req;
}

// A model provider: streams the answer; with break_after >= 0 it fails UNAVAILABLE after that many chunks.
class FailoverPeer final : public gateway::Provider::Service {
 public:
  FailoverPeer(std::string name, int break_after) : name_(std::move(name)), break_after_(break_after) {}

  grpc::Status StreamComplete(grpc::ServerContext*, const gateway::CompleteRequest*,
                              grpc::ServerWriter<gateway::Chunk>* srv) override {
    for (size_t i = 0; i < kFailoverTokens.size(); i++) {
      if (break_after_ >= 0 && static_cast<int>(i) == break_after_) {
        return grpc::Status(grpc::StatusCode::UNAVAILABLE, name_ + " lost its upstream");
      }
      gateway::Chunk chunk;
      chunk.set_text(kFailoverTokens[i]);
      if (!srv->Write(chunk)) return grpc::Status::CANCELLED;
    }
    return grpc::Status::OK;
  }

 private:
  std::string name_;
  int break_after_;
};

struct FailoverWorld {
  FailoverPeer primary;
  FailoverPeer fallback{"fallback", -1};
  explicit FailoverWorld(int primary_break_after) : primary("primary", primary_break_after) {}
};

void failoverWorld(harness::Ctx& ctx, int primary_break_after = -1) {
  static FailoverWorld* w = nullptr;
  delete w;
  w = new FailoverWorld(primary_break_after);
  ctx.GRPC.Server(kPrimary)->RegisterService(&w->primary);
  ctx.GRPC.Server(kFallback)->RegisterService(&w->fallback);
}

struct FailoverOut {
  std::vector<std::string> chunks;
  std::string error;  // what the call threw, "" if it returned
  bool ended = false;
};

// One call: the chunk texts it handed over and what it threw; ended is false if it never did.
FailoverOut failoverRun(harness::Ctx& ctx, const std::string& key) {
  FailoverOut out;
  out.ended = ctx.Drain([&] {
    try {
      stream_with_failover(failoverRequest(), key, [&](const gateway::Chunk& c) { out.chunks.push_back(c.text()); });
    } catch (const std::exception& e) {
      out.error = e.what()[0] ? e.what() : "an exception";
    }
  });
  return out;
}

size_t failoverCalls(harness::Ctx& ctx, const std::string& target) { return ctx.GRPC.CallsTo("StreamComplete", target).size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  failoverWorld(ctx);
  ctx.GRPC.SetLatency("StreamComplete", 20.0, kPrimary);
  const auto out = failoverRun(ctx, "k-1");
  ctx.Assert(out.ended, "with the primary stalled the call never ended (%d attempts on it): every attempt needs a deadline", failoverCalls(ctx, kPrimary));
  const auto primary = ctx.GRPC.CallsTo("StreamComplete", kPrimary);
  ctx.Assert(!primary.empty() && primary[0].HasDeadline(), "the StreamComplete call carries no deadline: a stalled provider holds the request open forever");
  ctx.Assert(7.5 <= primary[0].TimeoutSeconds() && primary[0].TimeoutSeconds() <= 8.5, "the deadline must be the 8 s stream deadline, got %vs", primary[0].TimeoutSeconds());
  ctx.Assert(out.error.empty(), "after the primary timed out the fallback must serve the answer; the call threw %s", out.error);
  ctx.Equal(out.chunks, kFailoverTokens, "after the primary timed out the fallback must serve the answer");
  ctx.Assert(primary.size() == 1 && failoverCalls(ctx, kFallback) == 1, "expected one attempt on each provider, got %d on primary and %d on fallback", primary.size(), failoverCalls(ctx, kFallback));
}

void CheckBounded(harness::Ctx& ctx) {
  failoverWorld(ctx);
  ctx.GRPC.Stop(kPrimary);
  ctx.GRPC.Stop(kFallback);
  const auto out = failoverRun(ctx, "k-1");
  const size_t total = failoverCalls(ctx, kPrimary) + failoverCalls(ctx, kFallback);
  ctx.Assert(out.ended, "with both providers down the call never ended: %d attempts and counting. Bound the attempts by the provider list", total);
  ctx.Assert(!out.error.empty(), "with both providers down the call must end with an error, it returned normally");
  ctx.Assert(total <= 2, "with both providers down the call made %d attempts, expected at most 2 (one per provider)", total);
}

void CheckRetryableAndIdempotent(harness::Ctx& ctx) {
  failoverWorld(ctx);
  ctx.GRPC.Fail("StreamComplete", grpc::StatusCode::INVALID_ARGUMENT, "bad request", 1, kPrimary);
  auto out = failoverRun(ctx, "k-1");
  ctx.Assert(out.ended && !out.error.empty(), "INVALID_ARGUMENT from the primary must be thrown to the caller at once");
  ctx.Equal(failoverCalls(ctx, kFallback), 0, "INVALID_ARGUMENT is not retryable: the fallback must not be tried (the request itself is wrong); fallback attempts");
  const auto state = ctx.Redis.Get("circuit:primary");
  ctx.Assert(!state || *state != "open", "a non-retryable failure must not count towards the breaker");
  out = failoverRun(ctx, "k-7");
  ctx.Assert(out.error.empty(), "a healthy primary must serve the answer; the call threw %s", out.error);
  ctx.Equal(out.chunks, kFailoverTokens, "a healthy primary must serve the answer");
  const auto md = ctx.GRPC.CallsTo("StreamComplete", kPrimary).back().Metadata;
  std::vector<std::string> keys;
  for (auto [it, end] = md.equal_range("idempotency-key"); it != end; ++it) keys.push_back(it->second);
  ctx.Equal(keys, {"k-7"}, "the attempt carried metadata %v; idempotency-key", md);
  const size_t before = failoverCalls(ctx, kPrimary);
  out = failoverRun(ctx, "");
  ctx.Assert(!out.error.empty() && failoverCalls(ctx, kPrimary) == before, "without an idempotency key the call must be refused before any attempt");
  failoverWorld(ctx, 2);
  out = failoverRun(ctx, "k-9");
  ctx.Equal(out.chunks, std::vector<std::string>(kFailoverTokens.begin(), kFailoverTokens.begin() + 2), "the caller must receive the two chunks the primary streamed before failing");
  ctx.Assert(!out.error.empty(), "a failure after the first chunk must be thrown: a retry would replay output the user already read");
  ctx.Equal(failoverCalls(ctx, kFallback), 0, "after a chunk was delivered the fallback must not be tried (it would replay and bill the answer twice); fallback attempts");
}

void CheckCircuitBreaker(harness::Ctx& ctx) {
  failoverWorld(ctx);
  for (int i = 0; i < 5; i++) {
    ctx.GRPC.Fail("StreamComplete", grpc::StatusCode::UNAVAILABLE, "primary restarting", 1, kPrimary);
    const auto out = failoverRun(ctx, "k-" + std::to_string(i));
    ctx.Assert(out.error.empty(), "attempt %d: the fallback must serve the answer while the primary fails; the call threw %s", i + 1, out.error);
    ctx.Equal(out.chunks, kFailoverTokens, "attempt %d: the fallback must serve the answer while the primary fails", i + 1);
  }
  const auto state = ctx.Redis.Get("circuit:primary");
  ctx.Equal(state, "open", "after five retryable failures circuit:primary");
  const long long ttl = ctx.Redis.TTL("circuit:primary");
  ctx.Assert(0 < ttl && ttl <= 30, "circuit:primary must expire within 30 s, its TTL is %d", ttl);
  const size_t before = failoverCalls(ctx, kPrimary);
  auto out = failoverRun(ctx, "k-open");
  ctx.Equal(failoverCalls(ctx, kPrimary), before, "while the breaker is open the primary must be skipped; primary attempts");
  ctx.Assert(out.error.empty() && out.chunks.size() == kFailoverTokens.size(), "while the breaker is open the fallback serves the answer");
  ctx.Clock.Advance(31);
  out = failoverRun(ctx, "k-closed");
  ctx.Equal(failoverCalls(ctx, kPrimary), before + 1, "once the breaker has expired the primary gets its turn again; primary attempts");
}

void CheckFallback(harness::Ctx& ctx) {
  failoverWorld(ctx);
  ctx.GRPC.Stop(kPrimary);
  const auto out = failoverRun(ctx, "k-1");
  ctx.Assert(out.ended, "with the primary down the call never ended: dial the fallback instead of the primary again");
  ctx.Assert(out.error.empty(), "with the primary down the fallback must serve the whole answer; the call threw %s", out.error);
  ctx.Equal(out.chunks, kFailoverTokens, "with the primary down the fallback must serve the whole answer");
  ctx.Equal(failoverCalls(ctx, kPrimary), 1, "the primary must be dialled once; primary attempts");
  ctx.Equal(failoverCalls(ctx, kFallback), 1, "the fallback must be dialled once; fallback attempts");
}
`,
  },
  debrief: `The loop is bounded by the provider list, not by a counter, because the list is the whole set of things worth trying: a second attempt on a provider that just said UNAVAILABLE is the attempt that turns an incident into a flood. The deadline is per attempt and is the stream's deadline, since a gRPC deadline covers the call from first byte to last; a shorter one would cut healthy streams short. The delivered flag exists because a stream is not idempotent once the user has read part of it, however good the key is. Production gateways hedge the first token (start the fallback after a few hundred milliseconds of silence rather than after a timeout), keep the breaker's state per provider and model, and half-open it with one probe request instead of waiting the full 30 s.`,
};
