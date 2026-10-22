import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vendor fetches with backoff and a circuit breaker',
  concept: 'grpc',
  file: 'client',
  focus: ['hub', 'vendor', 'oauth'],
  task: `## Task

The starter is a plausible model-generated draft: while the vendor is healthy every page arrives
and the sync advances. Every failure path is wrong. Find them, fix them, and prove the fix.

Implement \`fetch_page(connector)\`, the vendor call a sync worker makes for one page:

- Each attempt carries a **2 s** deadline. A call without one lets one slow vendor pin a worker for
  the whole sync.
- A **429** (\`RESOURCE_EXHAUSTED\`) is retried after **exponential backoff with jitter**:
  \`BACKOFF_BASE_MS = 250\`, doubling per attempt, capped at \`BACKOFF_MAX_MS = 8_000\`, with full
  jitter, and the vendor's own \`retry-after\` trailing metadata honoured when it sends one. At most
  \`MAX_ATTEMPTS = 5\` attempts. The draft re-sends 429s in a tight loop with no delay, which is how
  a polite client becomes the reason the vendor rate-limits you harder.
- A **401** (\`UNAUTHENTICATED\`) is permanent: it is attempted **once**, then the connector is
  **disabled with a visible reason** (\`store.disable(connector_id, reason)\`) so a human can see why
  it stopped and re-enable it after fixing the token. Retrying a 401 burns the rate limit and still
  fails forever.
- A **circuit breaker** opens after **5 consecutive 5xx** replies (\`UNAVAILABLE\`/\`INTERNAL\`)
  and stays open for \`BREAKER_COOLDOWN_S = 30\`; while it is open, \`allow()\` must short-circuit
  the call so five failures do not become thousands of requests against a vendor that is already
  down. A success resets the counter — the count is *consecutive*.
- Anything else — \`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\` — is returned to the caller at once
  instead of being retried.

**Failure mode the checks target.** The draft's blanket retry turns a vendor deploy into a hot loop
and a bad token into an infinite one; with no backoff the retries amplify exactly when the vendor is
asking you to slow down; and with no breaker a single broken vendor costs every worker its
throughput. Each of these is invisible in a demo where the vendor is healthy.`,
  sequence: {
    participants: ['Sync worker', 'Vendor gRPC', 'Connector store'],
    messages: [
      {from: 'Sync worker', to: 'Vendor gRPC', label: 'FetchPage · deadline 2 s', kind: 'sync'},
      {from: 'Vendor gRPC', to: 'Sync worker', label: '429 RESOURCE_EXHAUSTED · retry-after: 2', kind: 'reply'},
      {from: 'Sync worker', to: 'Sync worker', label: 'sleep min(8 s, 250 ms · 2^n) with jitter', kind: 'sync'},
      {from: 'Sync worker', to: 'Vendor gRPC', label: 'FetchPage · retry', kind: 'sync'},
      {from: 'Vendor gRPC', to: 'Sync worker', label: '401 UNAUTHENTICATED', kind: 'reply'},
      {
        from: 'Sync worker',
        to: 'Connector store',
        label: 'disable(connector, "vendor rejected the OAuth token")',
        kind: 'async',
      },
      {from: 'Sync worker', to: 'Sync worker', label: 'breaker.allow() · open after 5 consecutive 5xx', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'fetch',
      title: 'Calls the vendor fetch service',
      detail: 'The page comes from the vendor `FetchPage` RPC, not from a local read.',
      match: {
        python: {all: [/\.FetchPage\(/]},
        typescript: {all: [/\.fetchPage\(/]},
        go: {all: [/\.FetchPage\(/]},
        scala: {all: [/\.fetchPage\(/]},
        cpp: {all: [/->FetchPage\(/]},
      },
    },
    {
      id: 'backoff-429',
      title: 'Backs off with jitter before retrying a 429',
      detail:
        "A 429 waits `min(BACKOFF_MAX_MS, BACKOFF_BASE_MS · 2^n)` with jitter — or the vendor's `retry-after` — before the next attempt. The draft retries immediately in a tight loop, so a rate limit becomes a flood.",
      match: {
        python: {all: [/BACKOFF_BASE_MS/, /random\.uniform\(/, /time\.sleep\(/]},
        typescript: {all: [/BACKOFF_BASE_MS/, /Math\.random\(/, /setTimeout\(/]},
        go: {all: [/backoffBaseMS/, /rand\.Intn\(/, /time\.Sleep\(/]},
        scala: {all: [/BackoffBaseMs/, /nextLong\(/, /Thread\.sleep\(/]},
        cpp: {all: [/kBackoffBaseMs/, /uniform_int_distribution/, /sleep_for\(/]},
      },
    },
    {
      id: 'stop-on-401',
      title: 'Never retries a 401, and has no unbounded loop',
      detail:
        '`UNAUTHENTICATED` is recognized and returned immediately, and the attempts are counted against `MAX_ATTEMPTS` instead of a `while (true)` retry. The draft retries a bad token forever.',
      match: {
        python: {all: [/UNAUTHENTICATED/], none: [/while\s+True/]},
        typescript: {all: [/UNAUTHENTICATED/], none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/]},
        go: {all: [/codes\.Unauthenticated/], none: [/for\s*\{\s*\n/]},
        scala: {all: [/UNAUTHENTICATED/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/UNAUTHENTICATED/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'disable-with-reason',
      title: 'Disables the connector with a visible reason',
      detail:
        'A 401 disables the connector through the store with a human-readable reason, so the health endpoint and the operator both see why the sync stopped. The draft leaves the connector looking enabled while it fails on every run.',
      match: {
        python: {all: [/store\.disable\(/]},
        typescript: {all: [/store\.disable\(/]},
        go: {all: [/store\.Disable\(/]},
        scala: {all: [/\.disable\(/]},
        cpp: {all: [/store\.disable\(/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five consecutive 5xx for 30 s',
      detail:
        '`BREAKER_FAILURES = 5` consecutive 5xx replies open the breaker for `BREAKER_COOLDOWN_S = 30`, and `allow()` is checked before the call so an open breaker skips the vendor. A success resets the counter.',
      match: {
        python: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        typescript: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        go: {all: [/breakerFailures\s*=\s*5/, /breakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
        scala: {all: [/BreakerFailures\s*=\s*5/, /BreakerCooldownS\s*=\s*30/, /\.allow\(/]},
        cpp: {all: [/kBreakerFailures\s*=\s*5/, /kBreakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import vendor_pb2
import vendor_pb2_grpc

channel = grpc.insecure_channel("vendor:9000")
vendor = vendor_pb2_grpc.VendorStub(channel)


class ConnectorStore:
    def disable(self, connector_id: str, reason: str) -> None:
        """Mark the connector disabled so operators can see why its syncs stopped."""
        raise NotImplementedError


store = ConnectorStore()


def fetch_page(connector: dict) -> bytes:
    # TODO: this draft retries every status forever with no delay, including the 401 that can never
    # succeed, and has no breaker. Add exponential backoff with jitter for 429s, one attempt and a
    # disable for 401s, and a breaker after five consecutive 5xx.
    while True:
        try:
            reply = vendor.FetchPage(
                vendor_pb2.FetchPageRequest(connector_id=connector["id"], cursor=connector["cursor"])
            )
            return reply.records
        except Exception:
            continue
`,
      solution: `import random
import time

import grpc

import vendor_pb2
import vendor_pb2_grpc

DEADLINE_S = 2.0
MAX_ATTEMPTS = 5
BACKOFF_BASE_MS = 250
BACKOFF_MAX_MS = 8_000
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30
RETRYABLE = {
    grpc.StatusCode.RESOURCE_EXHAUSTED,
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
}
SERVER_ERRORS = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.INTERNAL}

channel = grpc.insecure_channel("vendor:9000")
vendor = vendor_pb2_grpc.VendorStub(channel)


class ConnectorStore:
    def disable(self, connector_id: str, reason: str) -> None:
        """Mark the connector disabled so operators can see why its syncs stopped."""
        raise NotImplementedError


store = ConnectorStore()


class Breaker:
    """Opens after BREAKER_FAILURES consecutive 5xx replies and cools down for 30 seconds."""

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

    def record(self, failed: bool) -> None:
        if not failed:
            self.failures = 0
            return
        self.failures += 1
        if self.failures >= BREAKER_FAILURES:
            self.opened_at = time.monotonic()


breaker = Breaker()


def retry_after_s(error: grpc.RpcError) -> float | None:
    """The vendor's own Retry-After, when it sends one in the trailing metadata."""
    for key, value in error.trailing_metadata() or ():
        if key == "retry-after":
            return float(value)
    return None


def backoff_ms(attempt: int, wait_s: float | None) -> float:
    """Exponential backoff with full jitter; the vendor's Retry-After wins when present."""
    if wait_s is not None:
        return wait_s * 1000
    return random.uniform(0, min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2**attempt)))


def fetch_page(connector: dict) -> bytes:
    for attempt in range(MAX_ATTEMPTS):
        if not breaker.allow():
            raise RuntimeError("vendor circuit open; skipping this run")
        try:
            reply = vendor.FetchPage(
                vendor_pb2.FetchPageRequest(
                    connector_id=connector["id"],
                    cursor=connector["cursor"],
                    token_ref=connector["token_ref"],
                ),
                timeout=DEADLINE_S,
            )
            breaker.record(False)
            return reply.records
        except grpc.RpcError as error:
            breaker.record(error.code() in SERVER_ERRORS)
            if error.code() == grpc.StatusCode.UNAUTHENTICATED:
                store.disable(connector["id"], reason="vendor rejected the OAuth token (401)")
                raise
            if error.code() not in RETRYABLE:
                raise
            if attempt == MAX_ATTEMPTS - 1:
                break
            time.sleep(backoff_ms(attempt, retry_after_s(error)) / 1000)
    raise RuntimeError("vendor fetch failed after retries")
`,
    },
    typescript: {
      starter: `/** fetchPage: a model-generated draft that retries every status in a tight loop. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Connector {
  id: string;
  cursor: string;
  token_ref: string;
}

interface VendorClient {
  fetchPage(
    request: {connector_id: string; cursor: string; token_ref: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {records: Buffer}) => void,
  ): grpc.ClientUnaryCall;
}

export const store = {
  disable: async (_connectorId: string, _reason: string): Promise<void> => undefined,
};

const {vendor} = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {
  vendor: {Vendor: new (target: string, credentials: grpc.ChannelCredentials) => VendorClient};
};
const client = new vendor.Vendor('vendor:9000', grpc.credentials.createInsecure());

export async function fetchPage(connector: Connector): Promise<Buffer> {
  // TODO: this draft retries every status forever with no delay, including the 401 that can never
  // succeed, and has no breaker. Add exponential backoff with jitter for 429s, one attempt and a
  // disable for 401s, and a breaker after five consecutive 5xx.
  for (;;) {
    try {
      const {promise, resolve, reject} = Promise.withResolvers<Buffer>();
      client.fetchPage(
        {connector_id: connector.id, cursor: connector.cursor, token_ref: connector.token_ref},
        {},
        (error, reply) => (error === null ? resolve(reply.records) : reject(error)),
      );
      return await promise;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** fetchPage: 429 backs off with jitter, 401 disables the connector, 5xx trip a breaker. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 2_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 8_000;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_S = 30;
const RETRYABLE: Record<number, true> = {
  [grpc.status.RESOURCE_EXHAUSTED]: true,
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};
const SERVER_ERRORS: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.INTERNAL]: true,
};

interface Connector {
  id: string;
  cursor: string;
  token_ref: string;
}

interface VendorClient {
  fetchPage(
    request: {connector_id: string; cursor: string; token_ref: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {records: Buffer}) => void,
  ): grpc.ClientUnaryCall;
}

export const store = {
  disable: async (_connectorId: string, _reason: string): Promise<void> => undefined,
};

const {vendor} = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {
  vendor: {Vendor: new (target: string, credentials: grpc.ChannelCredentials) => VendorClient};
};
const client = new vendor.Vendor('vendor:9000', grpc.credentials.createInsecure());

/** Opens after BREAKER_FAILURES consecutive 5xx replies and cools down for 30 seconds. */
class Breaker {
  private failures = 0;
  private openedAt = 0;

  allow(): boolean {
    if (this.failures < BREAKER_FAILURES) return true;
    if (Date.now() / 1000 - this.openedAt < BREAKER_COOLDOWN_S) return false;
    this.failures = 0;
    return true;
  }

  record(failed: boolean): void {
    if (!failed) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURES) this.openedAt = Date.now() / 1000;
  }
}

const breaker = new Breaker();

/** The vendor's own Retry-After, when it sends one; otherwise exponential backoff with full jitter. */
function backoffMs(attempt: number, error: grpc.ServiceError): number {
  const retryAfter = error.metadata?.get('retry-after')[0];
  if (typeof retryAfter === 'string') return Number(retryAfter) * 1000;
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

export async function fetchPage(connector: Connector): Promise<Buffer> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!breaker.allow()) throw new Error('vendor circuit open; skipping this run');
    try {
      const {promise, resolve, reject} = Promise.withResolvers<Buffer>();
      client.fetchPage(
        {connector_id: connector.id, cursor: connector.cursor, token_ref: connector.token_ref},
        {deadline: Date.now() + DEADLINE_MS},
        (error, reply) => (error === null ? resolve(reply.records) : reject(error)),
      );
      const records = await promise;
      breaker.record(false);
      return records;
    } catch (error) {
      const failure = error as grpc.ServiceError;
      breaker.record(SERVER_ERRORS[failure.code] === true);
      if (failure.code === grpc.status.UNAUTHENTICATED) {
        await store.disable(connector.id, 'vendor rejected the OAuth token (401)');
        throw failure;
      }
      if (RETRYABLE[failure.code] !== true) throw failure;
      if (attempt === MAX_ATTEMPTS - 1) break;
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, backoffMs(attempt, failure));
      await promise;
    }
  }
  throw new Error('vendor fetch failed after retries');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

var vendor pb.VendorClient

type Connector struct {
	ID       string
	Cursor   string
	TokenRef string
}

type ConnectorStore struct{}

func (s *ConnectorStore) Disable(ctx context.Context, connectorID, reason string) error {
	return nil
}

var store = &ConnectorStore{}

func fetchPage(ctx context.Context, connector Connector) ([]byte, error) {
	// TODO: this draft retries every status forever with no delay, including the 401 that can never
	// succeed, and has no breaker. Add exponential backoff with jitter for 429s, one attempt and a
	// disable for 401s, and a breaker after five consecutive 5xx.
	for {
		reply, err := vendor.FetchPage(ctx, &pb.FetchPageRequest{
			ConnectorId: connector.ID,
			Cursor:      connector.Cursor,
			TokenRef:    connector.TokenRef,
		})
		if err != nil {
			continue
		}
		return reply.Records, nil
	}
}
`,
      solution: `package main

import (
	"context"
	"math/rand"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS       = 2000
	maxAttempts      = 5
	backoffBaseMS    = 250
	backoffMaxMS     = 8000
	breakerFailures  = 5
	breakerCooldownS = 30
)

var vendor pb.VendorClient

type Connector struct {
	ID       string
	Cursor   string
	TokenRef string
}

type ConnectorStore struct{}

func (s *ConnectorStore) Disable(ctx context.Context, connectorID, reason string) error {
	return nil
}

var store = &ConnectorStore{}

func retryable(code codes.Code) bool {
	switch code {
	case codes.ResourceExhausted, codes.Unavailable, codes.DeadlineExceeded:
		return true
	default:
		return false
	}
}

func serverError(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.Internal
}

type breaker struct {
	failures int
	openedAt time.Time
}

func (b *breaker) allow() bool {
	if b.failures < breakerFailures {
		return true
	}
	if time.Since(b.openedAt) < breakerCooldownS*time.Second {
		return false
	}
	b.failures = 0
	return true
}

func (b *breaker) record(failed bool) {
	if !failed {
		b.failures = 0
		return
	}
	b.failures++
	if b.failures >= breakerFailures {
		b.openedAt = time.Now()
	}
}

var vendorBreaker = &breaker{}

// backoffMS is exponential with full jitter; the vendor's Retry-After wins when it sends one.
func backoffMS(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return retryAfter
	}
	ceiling := backoffBaseMS << attempt
	if ceiling > backoffMaxMS {
		ceiling = backoffMaxMS
	}
	return time.Duration(rand.Intn(ceiling)) * time.Millisecond
}

func retryAfter(err error) time.Duration {
	for _, md := range status.Convert(err).Details() {
		if value, ok := md.(interface{ GetRetryAfter() time.Duration }); ok {
			return value.GetRetryAfter()
		}
	}
	return 0
}

func fetchPage(ctx context.Context, connector Connector) ([]byte, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if !vendorBreaker.allow() {
			return nil, status.Error(codes.Unavailable, "vendor circuit open; skipping this run")
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := vendor.FetchPage(callCtx, &pb.FetchPageRequest{
			ConnectorId: connector.ID,
			Cursor:      connector.Cursor,
			TokenRef:    connector.TokenRef,
		})
		cancel()
		if err == nil {
			vendorBreaker.record(false)
			return reply.Records, nil
		}
		code := status.Code(err)
		vendorBreaker.record(serverError(code))
		if code == codes.Unauthenticated {
			_ = store.Disable(ctx, connector.ID, "vendor rejected the OAuth token (401)")
			return nil, err
		}
		if !retryable(code) {
			return nil, err
		}
		if attempt == maxAttempts-1 {
			break
		}
		time.Sleep(backoffMS(attempt, retryAfter(err)))
	}
	return nil, status.Error(codes.ResourceExhausted, "vendor fetch failed after retries")
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Connector(id: String, cursor: String, token_ref: String)

object VendorStore {
  def disable(connectorId: String, reason: String): Unit = ()
}

object VendorClient {
  val vendor = VendorGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build()
  )

  def fetchPage(connector: Connector): Array[Byte] = {
    // TODO: this draft retries every status forever with no delay, including the 401 that can never
    // succeed, and has no breaker. Add exponential backoff with jitter for 429s, one attempt and a
    // disable for 401s, and a breaker after five consecutive 5xx.
    while (true) {
      try {
        val reply = vendor.fetchPage(
          FetchPageRequest(connectorId = connector.id, cursor = connector.cursor, tokenRef = connector.token_ref)
        )
        return reply.records.toByteArray
      } catch {
        case _: Throwable => // retry
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.util.Random

final case class Connector(id: String, cursor: String, token_ref: String)

object VendorStore {
  def disable(connectorId: String, reason: String): Unit = ()
}

object VendorClient {
  val DeadlineMs = 2000L
  val MaxAttempts = 5
  val BackoffBaseMs = 250L
  val BackoffMaxMs = 8000L
  val BreakerFailures = 5
  val BreakerCooldownS = 30L

  val vendor = VendorGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build()
  )

  val Retryable = Set(Status.Code.RESOURCE_EXHAUSTED, Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  def serverError(code: Status.Code): Boolean =
    code == Status.Code.UNAVAILABLE || code == Status.Code.INTERNAL

  /** Opens after BreakerFailures consecutive 5xx replies and cools down for 30 seconds. */
  class Breaker {
    private var failures = 0
    private var openedAt = 0L

    def allow(): Boolean = {
      if (failures < BreakerFailures) true
      else if (System.currentTimeMillis() / 1000 - openedAt < BreakerCooldownS) false
      else {
        failures = 0
        true
      }
    }

    def record(failed: Boolean): Unit = {
      if (!failed) failures = 0
      else {
        failures += 1
        if (failures >= BreakerFailures) openedAt = System.currentTimeMillis() / 1000
      }
    }
  }

  val breaker = new Breaker

  /** Exponential backoff with full jitter; the vendor's retry-after wins when it sends one. */
  def backoffMs(attempt: Int, retryAfterMs: Long): Long =
    if (retryAfterMs > 0) retryAfterMs
    else Random.nextLong(Math.min(BackoffMaxMs, BackoffBaseMs << attempt) + 1)

  def retryAfterMs(error: StatusRuntimeException): Long =
    Option(error.getTrailers)
      .flatMap(trailers => Option(trailers.get(Metadata.Key.of("retry-after", Metadata.ASCII_STRING_MARSHALLER))))
      .map(value => (value.toDouble * 1000).toLong)
      .getOrElse(0L)

  def fetchPage(connector: Connector): Array[Byte] = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      if (!breaker.allow()) throw new RuntimeException("vendor circuit open; skipping this run")
      try {
        val reply = vendor
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .fetchPage(
            FetchPageRequest(connectorId = connector.id, cursor = connector.cursor, tokenRef = connector.token_ref)
          )
        breaker.record(failed = false)
        return reply.records.toByteArray
      } catch {
        case error: StatusRuntimeException =>
          breaker.record(serverError(error.getStatus.getCode))
          if (error.getStatus.getCode == Status.Code.UNAUTHENTICATED) {
            VendorStore.disable(connector.id, "vendor rejected the OAuth token (401)")
            throw error
          }
          if (!Retryable.contains(error.getStatus.getCode)) throw error
          if (attempt == MaxAttempts - 1) throw error
          Thread.sleep(backoffMs(attempt, retryAfterMs(error)))
      }
      attempt += 1
    }
    throw new RuntimeException("vendor fetch failed after retries")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "vendor.grpc.pb.h"

#include <string>

std::unique_ptr<Vendor::Stub> vendor;

struct Connector {
  std::string id;
  std::string cursor;
  std::string token_ref;
};

struct ConnectorStore {
  void disable(const std::string& connectorId, const std::string& reason);
};

ConnectorStore store;

std::string fetchPage(const Connector& connector) {
  // TODO: this draft retries every status forever with no delay, including the 401 that can never
  // succeed, and has no breaker. Add exponential backoff with jitter for 429s, one attempt and a
  // disable for 401s, and a breaker after five consecutive 5xx.
  while (true) {
    grpc::ClientContext ctx;
    FetchPageRequest request;
    request.set_connector_id(connector.id);
    request.set_cursor(connector.cursor);
    FetchPageReply reply;
    const grpc::Status status = vendor->FetchPage(&ctx, request, &reply);
    if (!status.ok()) continue;
    return reply.records();
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "vendor.grpc.pb.h"

#include <chrono>
#include <random>
#include <string>
#include <thread>

constexpr int kDeadlineMs = 2000;
constexpr int kMaxAttempts = 5;
constexpr int kBackoffBaseMs = 250;
constexpr int kBackoffMaxMs = 8000;
constexpr int kBreakerFailures = 5;
constexpr int kBreakerCooldownS = 30;

std::unique_ptr<Vendor::Stub> vendor;

struct Connector {
  std::string id;
  std::string cursor;
  std::string token_ref;
};

struct ConnectorStore {
  void disable(const std::string& connectorId, const std::string& reason);
};

ConnectorStore store;

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::RESOURCE_EXHAUSTED || code == grpc::StatusCode::UNAVAILABLE ||
         code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

bool server_error(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::INTERNAL;
}

/** Opens after kBreakerFailures consecutive 5xx replies and cools down for 30 seconds. */
class Breaker {
 public:
  bool allow() {
    if (failures_ < kBreakerFailures) return true;
    const auto now = std::chrono::system_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - opened_at_).count() < kBreakerCooldownS) return false;
    failures_ = 0;
    return true;
  }

  void record(bool failed) {
    if (!failed) {
      failures_ = 0;
      return;
    }
    failures_ += 1;
    if (failures_ >= kBreakerFailures) opened_at_ = std::chrono::system_clock::now();
  }

 private:
  int failures_ = 0;
  std::chrono::system_clock::time_point opened_at_ = std::chrono::system_clock::now();
};

Breaker breaker;

/** Exponential backoff with full jitter; the vendor's retry-after wins when it sends one. */
std::chrono::milliseconds backoff_ms(int attempt, int retry_after_ms) {
  if (retry_after_ms > 0) return std::chrono::milliseconds(retry_after_ms);
  const int ceiling = std::min(kBackoffMaxMs, kBackoffBaseMs << attempt);
  static std::mt19937 rng{std::random_device{}()};
  return std::chrono::milliseconds(std::uniform_int_distribution<int>(0, ceiling)(rng));
}

int retry_after_ms(const grpc::Status& status) {
  const auto& trailers = status.error_details();
  if (trailers.empty()) return 0;
  return static_cast<int>(std::stod(trailers) * 1000);
}

std::string fetchPage(const Connector& connector) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    if (!breaker.allow()) throw std::runtime_error("vendor circuit open; skipping this run");
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    FetchPageRequest request;
    request.set_connector_id(connector.id);
    request.set_cursor(connector.cursor);
    request.set_token_ref(connector.token_ref);
    FetchPageReply reply;
    const grpc::Status status = vendor->FetchPage(&ctx, request, &reply);
    if (status.ok()) {
      breaker.record(false);
      return reply.records();
    }
    breaker.record(server_error(status.error_code()));
    if (status.error_code() == grpc::StatusCode::UNAUTHENTICATED) {
      store.disable(connector.id, "vendor rejected the OAuth token (401)");
      throw std::runtime_error(status.error_message());
    }
    if (!retryable(status.error_code())) throw std::runtime_error(status.error_message());
    if (attempt == kMaxAttempts - 1) break;
    std::this_thread::sleep_for(backoff_ms(attempt, retry_after_ms(status)));
  }
  throw std::runtime_error("vendor fetch failed after retries");
}
`,
    },
  },
  hints: [
    'Separate the statuses before you write the loop: retryable is `RESOURCE_EXHAUSTED` / `UNAVAILABLE` / `DEADLINE_EXCEEDED`, permanent is `UNAUTHENTICATED` / `INVALID_ARGUMENT` / `PERMISSION_DENIED`. A permanent code returns on the first attempt — there is no third try that succeeds with a bad token.',
    'Backoff belongs between attempts, not in front of the first one: `min(BACKOFF_MAX_MS, BACKOFF_BASE_MS · 2^attempt)` with jitter, and if the vendor sent `retry-after` in the trailing metadata, that value overrides your own schedule. Sleeping zero is the draft.',
    'The breaker counts *consecutive* 5xx replies: `record(failed)` resets the counter on success and opens after `BREAKER_FAILURES`, and `allow()` is checked before the call so an open breaker returns without touching the vendor. A 401 is not a breaker event — it is a connector that must be disabled once.',
  ],
  debrief: `The interview question is failure policy against a dependency you do not control. The draft passes every serial test with a healthy vendor and fails exactly when the vendor is having its worst day: an unbounded retry with no delay turns your client into the load that keeps the vendor down, retrying a 401 burns rate limit for a result that can never change, and with no breaker every worker independently rediscovers that the vendor is out. The fixes are the four contracts every outbound call needs — a deadline, bounded attempts over a status whitelist, a backoff policy that honours the server's own instructions, and a breaker so the dependency gets room to recover. Real hubs also include the connector's own rate limit as a client-side token bucket, a per-connector concurrency cap so one big connector cannot starve the rest, and an alarm on the breaker opening so a vendorship problem reaches a human.`,
};
