import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vendor fetches with a deadline, backoff and a breaker',
  concept: 'grpc',
  file: 'client',
  focus: ['hub', 'vendor', 'oauth', 'redis'],
  task: `## Task

**Starting point.** The starter is the vendor client of the sync worker:
\`fetch_page(connector_id, cursor)\` reads the connector from \`hub.store\`, calls \`Vendor.FetchPage\`
with its token reference and retries any error at once, up to \`MAX_ATTEMPTS\` (5) calls, before
raising \`VendorUnavailable\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A vendor that stops answering holds the worker as long as it
likes; a 429 gets four more requests in the same millisecond; a revoked token is sent five times a
run while the connector looks enabled; and a vendor outage costs every run five calls.

\`\`\`proto
service Vendor { rpc FetchPage(FetchPageRequest) returns (Page); }
// RESOURCE_EXHAUSTED = 429 · UNAUTHENTICATED = 401 · UNAVAILABLE, INTERNAL = 5xx
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 2 s** deadline.
- \`RESOURCE_EXHAUSTED\` is retried after half to all of \`min(BACKOFF_MAX_S, BACKOFF_BASE_S · 2^attempt)\`
  (0.25 s, 8 s), at most \`MAX_ATTEMPTS\` calls, then \`VendorUnavailable\`.
- \`UNAUTHENTICATED\` is final: \`store.disable(connector_id, reason)\`, raise \`VendorAuthFailed\`; a
  disabled connector makes no call.
- Any other failure, a deadline included, raises \`VendorUnavailable\` and does
  \`HINCRBY health:{id} consecutive_failures\`; at \`BREAKER_FAILURES\` (5) it sets \`open_until\` to now
  plus \`BREAKER_COOLDOWN_S\` (30), and until then a fetch raises \`BreakerOpen\` without a call. A
  success resets the count; every answered call sets \`last_run_at\`.`,
  sequence: {
    participants: ['Sync worker', 'Redis health', 'Vendor', 'Registry'],
    messages: [
      {from: 'Sync worker', to: 'Redis health', label: 'HGET health:{id} open_until → closed', kind: 'sync'},
      {from: 'Sync worker', to: 'Vendor', label: 'FetchPage · deadline 2 s', kind: 'sync'},
      {from: 'Vendor', to: 'Sync worker', label: 'RESOURCE_EXHAUSTED', kind: 'reply'},
      {from: 'Sync worker', to: 'Sync worker', label: 'sleep ½–1 × min(8 s, 0.25 s · 2^n)', kind: 'sync'},
      {from: 'Vendor', to: 'Sync worker', label: 'UNAUTHENTICATED', kind: 'reply'},
      {from: 'Sync worker', to: 'Registry', label: 'disable(id, "vendor rejected the OAuth token")', kind: 'sync'},
      {
        from: 'Sync worker',
        to: 'Redis health',
        label: '5xx → HINCRBY consecutive_failures · open_until at 5',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every vendor call carries a 2-second deadline',
      detail:
        '`FetchPage` is called with `DEADLINE_S` (2 s); without one a vendor that stops answering holds the worker for as long as the vendor likes. A deadline is reported as `VendorUnavailable` and counted toward the breaker.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2(\.0)?\b/, /FetchPage\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000\b/, /deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineMillis\s*=\s*2000L?\b/, /withDeadlineAfter\(\s*DeadlineMillis/]},
        cpp: {all: [/kDeadline\{2\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'backoff',
      title: 'Backs off a 429 with growing, jittered waits',
      detail:
        '`RESOURCE_EXHAUSTED` is retried after a wait of half to all of `min(BACKOFF_MAX_S, BACKOFF_BASE_S · 2^attempt)`, at most `MAX_ATTEMPTS` calls; retrying at once is the flood the vendor asked to stop.',
      match: {
        python: {all: [/RESOURCE_EXHAUSTED/, /time\.sleep\(/, /2\s*\*\*\s*attempt/, /random\./]},
        typescript: {all: [/RESOURCE_EXHAUSTED/, /setTimeout\(/, /2\s*\*\*\s*attempt/, /Math\.random\(/]},
        go: {all: [/codes\.ResourceExhausted/, /time\.Sleep\(/, /<<\s*attempt/, /rand\./]},
        scala: {all: [/RESOURCE_EXHAUSTED/, /Thread\.sleep\(/, /<<\s*attempt/, /Random\./]},
        cpp: {all: [/RESOURCE_EXHAUSTED/, /sleep_for\(/, /<<\s*attempt/, /uniform_(int|real)_distribution/]},
      },
    },
    {
      id: 'auth-terminal',
      title: 'A rejected token disables the connector after one call',
      detail:
        '`UNAUTHENTICATED` is not retried: the connector is disabled through the registry with a reason an operator can read, `VendorAuthFailed` is raised, and a disabled connector makes no further call.',
      match: {
        python: {all: [/UNAUTHENTICATED/, /store\.disable\(/, /raise VendorAuthFailed/]},
        typescript: {all: [/UNAUTHENTICATED/, /\bdisable\(/, /throw new VendorAuthFailed/]},
        go: {all: [/codes\.Unauthenticated/, /store\.Disable\(/, /Errorf\([^\n]*ErrVendorAuthFailed/]},
        scala: {all: [/UNAUTHENTICATED/, /Store\.disable\(/, /throw new VendorAuthFailed/]},
        cpp: {all: [/UNAUTHENTICATED/, /store::disable\(/, /throw VendorAuthFailed/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five consecutive failures',
      detail:
        'A 5xx or a deadline counts in `health:{id}` (`consecutive_failures`); at `BREAKER_FAILURES` (5) `open_until` is set `BREAKER_COOLDOWN_S` (30) ahead and a fetch raises `BreakerOpen` without calling the vendor until it passes; a success resets the count.',
      match: {
        python: {
          all: [/BREAKER_FAILURES\s*=\s*5\b/, /BREAKER_COOLDOWN_S\s*=\s*30\b/, /open_until/, /consecutive_failures/],
        },
        typescript: {
          all: [/BREAKER_FAILURES\s*=\s*5\b/, /BREAKER_COOLDOWN_S\s*=\s*30\b/, /open_until/, /consecutive_failures/],
        },
        go: {all: [/breakerFailures\s*=\s*5\b/, /breakerCooldownS\s*=\s*30\b/, /open_until/, /consecutive_failures/]},
        scala: {
          all: [/BreakerFailures\s*=\s*5L?\b/, /BreakerCooldownS\s*=\s*30L?\b/, /open_until/, /consecutive_failures/],
        },
        cpp: {
          all: [/kBreakerFailures\s*=\s*5\b/, /kBreakerCooldownS\s*=\s*30\b/, /open_until/, /consecutive_failures/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import vendor_pb2
import vendor_pb2_grpc
from hub import store  # get, disable

MAX_ATTEMPTS = 5

log = logging.getLogger("connectord.client")
vendor = vendor_pb2_grpc.VendorStub(grpc.insecure_channel("vendor:9000"))


class VendorAuthFailed(Exception):
    """The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it."""


class VendorUnavailable(Exception):
    """The vendor failed or did not answer in time: the next scheduled run tries again."""


class BreakerOpen(Exception):
    """Too many consecutive failures: the vendor is left alone until the cooldown ends."""


def fetch_page(connector_id: str, cursor: str) -> vendor_pb2.Page:
    """One page of the connector's records, starting at cursor."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    connector = store.get(connector_id)
    request = vendor_pb2.FetchPageRequest(connector_id=connector_id, cursor=cursor, token_ref=connector["token_ref"])
    for attempt in range(MAX_ATTEMPTS):
        try:
            return vendor.FetchPage(request)
        except grpc.RpcError as exc:
            log.warning("FetchPage for %s failed with %s (attempt %d), retrying", connector_id, exc.code().name, attempt + 1)
    raise VendorUnavailable(f"FetchPage failed {MAX_ATTEMPTS} times")
`,
      solution: `import logging
import random
import time

import grpc
import redis

import vendor_pb2
import vendor_pb2_grpc
from hub import store  # get, disable

DEADLINE_S = 2.0
MAX_ATTEMPTS = 5
BACKOFF_BASE_S = 0.25
BACKOFF_MAX_S = 8.0
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30

log = logging.getLogger("connectord.client")
vendor = vendor_pb2_grpc.VendorStub(grpc.insecure_channel("vendor:9000"))
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class VendorAuthFailed(Exception):
    """The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it."""


class VendorUnavailable(Exception):
    """The vendor failed or did not answer in time: the next scheduled run tries again."""


class BreakerOpen(Exception):
    """Too many consecutive failures: the vendor is left alone until the cooldown ends."""


def health_key(connector_id: str) -> str:
    return f"health:{connector_id}"


def backoff_s(attempt: int) -> float:
    """Half to all of the exponential ceiling: retries spread out instead of arriving together."""
    ceiling = min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2**attempt)
    return ceiling / 2 + random.uniform(0, ceiling / 2)


def record_failure(connector_id: str) -> None:
    now = int(time.time())
    failures = r.hincrby(health_key(connector_id), "consecutive_failures", 1)
    r.hset(health_key(connector_id), "last_run_at", now)
    if failures >= BREAKER_FAILURES:
        r.hset(health_key(connector_id), "open_until", now + BREAKER_COOLDOWN_S)


def record_success(connector_id: str) -> None:
    r.hset(health_key(connector_id), mapping={"consecutive_failures": 0, "open_until": 0, "last_run_at": int(time.time())})


def fetch_page(connector_id: str, cursor: str) -> vendor_pb2.Page:
    """One page of the connector's records, starting at cursor."""
    connector = store.get(connector_id)
    if connector["status"] == "disabled":
        raise VendorAuthFailed(connector["disabled_reason"])
    if time.time() < int(r.hget(health_key(connector_id), "open_until") or 0):
        raise BreakerOpen(f"{connector_id}: the vendor breaker is open")
    request = vendor_pb2.FetchPageRequest(connector_id=connector_id, cursor=cursor, token_ref=connector["token_ref"])
    for attempt in range(MAX_ATTEMPTS):
        try:
            page = vendor.FetchPage(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAUTHENTICATED:
                # Retrying cannot fix a revoked token: stop the connector where an operator sees why.
                store.disable(connector_id, "vendor rejected the OAuth token (401)")
                raise VendorAuthFailed(exc.details()) from exc
            if exc.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
                if attempt + 1 < MAX_ATTEMPTS:
                    time.sleep(backoff_s(attempt))
                continue
            # A 5xx or a deadline: the scheduler runs again later; the breaker stops the runs piling up.
            record_failure(connector_id)
            raise VendorUnavailable(f"FetchPage: {exc.code().name}") from exc
        record_success(connector_id)
        return page
    log.warning("FetchPage for %s still rate limited after %d attempts", connector_id, MAX_ATTEMPTS)
    raise VendorUnavailable(f"FetchPage: still rate limited after {MAX_ATTEMPTS} attempts")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {disable, get} from 'hub/store';

export const MAX_ATTEMPTS = 5;

export interface SourceRecord {
  id: string;
  body: string;
}

export interface Page {
  records: SourceRecord[];
  next_cursor: string;
}

interface FetchPageRequest {
  connector_id: string;
  cursor: string;
  token_ref: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {hub: {Vendor: grpc.ServiceClientConstructor}};
const vendor = new pkg.hub.Vendor('vendor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  FetchPage(request: FetchPageRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Page>;
};

/** The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it. */
export class VendorAuthFailed extends Error {}
/** The vendor failed or did not answer in time: the next scheduled run tries again. */
export class VendorUnavailable extends Error {}
/** Too many consecutive failures: the vendor is left alone until the cooldown ends. */
export class BreakerOpen extends Error {}

/** One page of the connector's records, starting at cursor. */
export async function fetchPage(connectorId: string, cursor: string): Promise<Page> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const connector = await get(connectorId);
  if (connector === null) throw new Error(\`no connector \${connectorId}\`);
  const request = {connector_id: connectorId, cursor, token_ref: connector.token_ref};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await vendor.FetchPage(request, new grpc.Metadata(), {});
    } catch (e) {
      console.warn(\`FetchPage for \${connectorId} failed with \${grpc.status[(e as grpc.ServiceError).code]} (attempt \${attempt + 1}), retrying\`);
    }
  }
  throw new VendorUnavailable(\`FetchPage failed \${MAX_ATTEMPTS} times\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {disable, get} from 'hub/store';

export const DEADLINE_MS = 2000;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_S = 0.25;
export const BACKOFF_MAX_S = 8;
export const BREAKER_FAILURES = 5;
export const BREAKER_COOLDOWN_S = 30;

export interface SourceRecord {
  id: string;
  body: string;
}

export interface Page {
  records: SourceRecord[];
  next_cursor: string;
}

interface FetchPageRequest {
  connector_id: string;
  cursor: string;
  token_ref: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {hub: {Vendor: grpc.ServiceClientConstructor}};
const vendor = new pkg.hub.Vendor('vendor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  FetchPage(request: FetchPageRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Page>;
};
const redis = new Redis({host: 'redis', port: 6379});

/** The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it. */
export class VendorAuthFailed extends Error {}
/** The vendor failed or did not answer in time: the next scheduled run tries again. */
export class VendorUnavailable extends Error {}
/** Too many consecutive failures: the vendor is left alone until the cooldown ends. */
export class BreakerOpen extends Error {}

const healthKey = (connectorId: string): string => \`health:\${connectorId}\`;
const nowS = (): number => Math.floor(Date.now() / 1000);

/** Half to all of the exponential ceiling: retries spread out instead of arriving together. */
export function backoffS(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

const sleep = (seconds: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, seconds * 1000);
  return promise;
};

async function recordFailure(connectorId: string): Promise<void> {
  const failures = await redis.hincrby(healthKey(connectorId), 'consecutive_failures', 1);
  await redis.hset(healthKey(connectorId), 'last_run_at', nowS());
  if (failures >= BREAKER_FAILURES) await redis.hset(healthKey(connectorId), 'open_until', nowS() + BREAKER_COOLDOWN_S);
}

async function recordSuccess(connectorId: string): Promise<void> {
  await redis.hset(healthKey(connectorId), {consecutive_failures: 0, open_until: 0, last_run_at: nowS()});
}

/** One page of the connector's records, starting at cursor. */
export async function fetchPage(connectorId: string, cursor: string): Promise<Page> {
  const connector = await get(connectorId);
  if (connector === null) throw new Error(\`no connector \${connectorId}\`);
  if (connector.status === 'disabled') throw new VendorAuthFailed(connector.disabled_reason);
  if (nowS() < Number((await redis.hget(healthKey(connectorId), 'open_until')) ?? 0)) throw new BreakerOpen(\`\${connectorId}: the vendor breaker is open\`);
  const request = {connector_id: connectorId, cursor, token_ref: connector.token_ref};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let page: Page;
    try {
      page = await vendor.FetchPage(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.UNAUTHENTICATED) {
        // Retrying cannot fix a revoked token: stop the connector where an operator sees why.
        await disable(connectorId, 'vendor rejected the OAuth token (401)');
        throw new VendorAuthFailed(details);
      }
      if (code === grpc.status.RESOURCE_EXHAUSTED) {
        if (attempt + 1 < MAX_ATTEMPTS) await sleep(backoffS(attempt));
        continue;
      }
      // A 5xx or a deadline: the scheduler runs again later; the breaker stops the runs piling up.
      await recordFailure(connectorId);
      throw new VendorUnavailable(\`FetchPage: \${grpc.status[code]}\`);
    }
    await recordSuccess(connectorId);
    return page;
  }
  throw new VendorUnavailable(\`FetchPage: still rate limited after \${MAX_ATTEMPTS} attempts\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "hub/gen/vendor"
	"hub/store" // store.Get, Disable
)

const maxAttempts = 5

var (
	vendorConn, _ = grpc.NewClient("vendor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vendor        = pb.NewVendorClient(vendorConn)
)

var (
	// ErrVendorAuthFailed: the vendor rejected the connector's OAuth token; it stays disabled until a human fixes it.
	ErrVendorAuthFailed = errors.New("vendor rejected the OAuth token")
	// ErrVendorUnavailable: the vendor failed or did not answer in time; the next scheduled run tries again.
	ErrVendorUnavailable = errors.New("vendor unavailable")
	// ErrBreakerOpen: too many consecutive failures; the vendor is left alone until the cooldown ends.
	ErrBreakerOpen = errors.New("vendor breaker open")
)

// fetchPage is one page of the connector's records, starting at cursor.
func fetchPage(ctx context.Context, connectorID, cursor string) (*pb.Page, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	connector := store.Get(ctx, connectorID)
	if connector == nil {
		return nil, fmt.Errorf("no connector %s", connectorID)
	}
	request := &pb.FetchPageRequest{ConnectorId: connectorID, Cursor: cursor, TokenRef: connector.TokenRef}
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		page, err := vendor.FetchPage(ctx, request)
		if err == nil {
			return page, nil
		}
		last = err
		log.Printf("FetchPage for %s failed with %v (attempt %d), retrying", connectorID, status.Code(err), attempt+1)
	}
	return nil, fmt.Errorf("%w: %v", ErrVendorUnavailable, last)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "hub/gen/vendor"
	"hub/store" // store.Get, Disable
)

const (
	deadline         = 2 * time.Second
	maxAttempts      = 5
	backoffBase      = 250 * time.Millisecond
	backoffMax       = 8 * time.Second
	breakerFailures  = 5
	breakerCooldownS = 30
)

var (
	vendorConn, _ = grpc.NewClient("vendor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vendor        = pb.NewVendorClient(vendorConn)
	rdb           = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

var (
	// ErrVendorAuthFailed: the vendor rejected the connector's OAuth token; it stays disabled until a human fixes it.
	ErrVendorAuthFailed = errors.New("vendor rejected the OAuth token")
	// ErrVendorUnavailable: the vendor failed or did not answer in time; the next scheduled run tries again.
	ErrVendorUnavailable = errors.New("vendor unavailable")
	// ErrBreakerOpen: too many consecutive failures; the vendor is left alone until the cooldown ends.
	ErrBreakerOpen = errors.New("vendor breaker open")
)

func healthKey(connectorID string) string { return "health:" + connectorID }

// backoff is half to all of the exponential ceiling: retries spread out instead of arriving together.
func backoff(attempt int) time.Duration {
	ceiling := backoffBase << attempt
	if ceiling > backoffMax {
		ceiling = backoffMax
	}
	return ceiling/2 + time.Duration(rand.Int64N(int64(ceiling/2)+1))
}

func recordFailure(ctx context.Context, connectorID string) {
	now := time.Now().Unix()
	failures := rdb.HIncrBy(ctx, healthKey(connectorID), "consecutive_failures", 1).Val()
	rdb.HSet(ctx, healthKey(connectorID), "last_run_at", now)
	if failures >= breakerFailures {
		rdb.HSet(ctx, healthKey(connectorID), "open_until", now+breakerCooldownS)
	}
}

func recordSuccess(ctx context.Context, connectorID string) {
	rdb.HSet(ctx, healthKey(connectorID), map[string]any{"consecutive_failures": 0, "open_until": 0, "last_run_at": time.Now().Unix()})
}

// fetchPage is one page of the connector's records, starting at cursor.
func fetchPage(ctx context.Context, connectorID, cursor string) (*pb.Page, error) {
	connector := store.Get(ctx, connectorID)
	if connector == nil {
		return nil, fmt.Errorf("no connector %s", connectorID)
	}
	if connector.Status == "disabled" {
		return nil, fmt.Errorf("%w: %s", ErrVendorAuthFailed, connector.DisabledReason)
	}
	openUntil, _ := strconv.ParseInt(rdb.HGet(ctx, healthKey(connectorID), "open_until").Val(), 10, 64)
	if time.Now().Unix() < openUntil {
		return nil, fmt.Errorf("%w: %s", ErrBreakerOpen, connectorID)
	}
	request := &pb.FetchPageRequest{ConnectorId: connectorID, Cursor: cursor, TokenRef: connector.TokenRef}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		page, err := vendor.FetchPage(callCtx, request)
		cancel()
		if err == nil {
			recordSuccess(ctx, connectorID)
			return page, nil
		}
		code := status.Code(err)
		if code == codes.Unauthenticated {
			// Retrying cannot fix a revoked token: stop the connector where an operator sees why.
			store.Disable(ctx, connectorID, "vendor rejected the OAuth token (401)")
			return nil, fmt.Errorf("%w: %v", ErrVendorAuthFailed, err)
		}
		if code == codes.ResourceExhausted {
			if attempt+1 < maxAttempts {
				time.Sleep(backoff(attempt))
			}
			continue
		}
		// A 5xx or a deadline: the scheduler runs again later; the breaker stops the runs piling up.
		recordFailure(ctx, connectorID)
		return nil, fmt.Errorf("%w: %v", ErrVendorUnavailable, code)
	}
	return nil, fmt.Errorf("%w: still rate limited after %d attempts", ErrVendorUnavailable, maxAttempts)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import hub.Store // Store.get, disable
import hub.vendor.{FetchPageRequest, Page, VendorGrpc}

/** The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it. */
final class VendorAuthFailed(message: String) extends Exception(message)
/** The vendor failed or did not answer in time: the next scheduled run tries again. */
final class VendorUnavailable(message: String) extends Exception(message)
/** Too many consecutive failures: the vendor is left alone until the cooldown ends. */
final class BreakerOpen(message: String) extends Exception(message)

object Client {
  val MaxAttempts = 5

  private val vendor = VendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())

  /** One page of the connector's records, starting at cursor. */
  def fetchPage(connectorId: String, cursor: String): Page = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val connector = Store.get(connectorId).getOrElse(throw new NoSuchElementException(s"no connector $connectorId"))
    val request = FetchPageRequest(connectorId, cursor, connector.tokenRef)
    var attempt = 0
    while (attempt < MaxAttempts) {
      try return vendor.fetchPage(request)
      catch {
        case e: StatusRuntimeException =>
          System.err.println(s"FetchPage for $connectorId failed with \${e.getStatus.getCode} (attempt \${attempt + 1}), retrying")
      }
      attempt += 1
    }
    throw new VendorUnavailable(s"FetchPage failed $MaxAttempts times")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.Random

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import hub.Store // Store.get, disable
import hub.vendor.{FetchPageRequest, Page, VendorGrpc}

/** The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it. */
final class VendorAuthFailed(message: String) extends Exception(message)
/** The vendor failed or did not answer in time: the next scheduled run tries again. */
final class VendorUnavailable(message: String) extends Exception(message)
/** Too many consecutive failures: the vendor is left alone until the cooldown ends. */
final class BreakerOpen(message: String) extends Exception(message)

object Client {
  val DeadlineMillis = 2000L
  val MaxAttempts = 5
  val BackoffBaseMillis = 250L
  val BackoffMaxMillis = 8000L
  val BreakerFailures = 5L
  val BreakerCooldownS = 30L

  private val vendor = VendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())
  val jedis = new JedisPooled("redis", 6379)

  def healthKey(connectorId: String): String = s"health:$connectorId"
  private def nowS: Long = System.currentTimeMillis() / 1000

  /** Half to all of the exponential ceiling: retries spread out instead of arriving together. */
  def backoffMillis(attempt: Int): Long = {
    val ceiling = math.min(BackoffMaxMillis, BackoffBaseMillis << attempt)
    ceiling / 2 + Random.nextLong(ceiling / 2 + 1)
  }

  private def recordFailure(connectorId: String): Unit = {
    val failures = jedis.hincrBy(healthKey(connectorId), "consecutive_failures", 1L)
    jedis.hset(healthKey(connectorId), "last_run_at", nowS.toString)
    if (failures >= BreakerFailures) jedis.hset(healthKey(connectorId), "open_until", (nowS + BreakerCooldownS).toString)
  }

  private def recordSuccess(connectorId: String): Unit =
    jedis.hset(healthKey(connectorId), Map("consecutive_failures" -> "0", "open_until" -> "0", "last_run_at" -> nowS.toString).asJava)

  /** One page of the connector's records, starting at cursor. */
  def fetchPage(connectorId: String, cursor: String): Page = {
    val connector = Store.get(connectorId).getOrElse(throw new NoSuchElementException(s"no connector $connectorId"))
    if (connector.status == "disabled") throw new VendorAuthFailed(connector.disabledReason)
    val openUntil = Option(jedis.hget(healthKey(connectorId), "open_until")).flatMap(_.toLongOption).getOrElse(0L)
    if (nowS < openUntil) throw new BreakerOpen(s"$connectorId: the vendor breaker is open")
    val request = FetchPageRequest(connectorId, cursor, connector.tokenRef)
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val page = vendor.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).fetchPage(request)
        recordSuccess(connectorId)
        return page
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAUTHENTICATED =>
          // Retrying cannot fix a revoked token: stop the connector where an operator sees why.
          Store.disable(connectorId, "vendor rejected the OAuth token (401)")
          throw new VendorAuthFailed(Option(e.getStatus.getDescription).getOrElse("unauthenticated"))
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.RESOURCE_EXHAUSTED =>
          if (attempt + 1 < MaxAttempts) Thread.sleep(backoffMillis(attempt))
        case e: StatusRuntimeException =>
          // A 5xx or a deadline: the scheduler runs again later; the breaker stops the runs piling up.
          recordFailure(connectorId)
          throw new VendorUnavailable(s"FetchPage: \${e.getStatus.getCode}")
      }
      attempt += 1
    }
    throw new VendorUnavailable(s"FetchPage: still rate limited after $MaxAttempts attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <stdexcept>
#include <string>

#include "hub/store.h"  // store::get, disable
#include "vendor.grpc.pb.h"

constexpr int kMaxAttempts = 5;

auto vendor = hub::Vendor::NewStub(grpc::CreateChannel("vendor:9000", grpc::InsecureChannelCredentials()));

// The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it.
struct VendorAuthFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The vendor failed or did not answer in time: the next scheduled run tries again.
struct VendorUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// Too many consecutive failures: the vendor is left alone until the cooldown ends.
struct BreakerOpen : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One page of the connector's records, starting at cursor.
hub::Page fetchPage(const std::string& connector_id, const std::string& cursor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto connector = store::get(connector_id);
  if (!connector) throw std::out_of_range("no connector " + connector_id);
  hub::FetchPageRequest request;
  request.set_connector_id(connector_id);
  request.set_cursor(cursor);
  request.set_token_ref(connector->token_ref);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    hub::Page page;
    const grpc::Status status = vendor->FetchPage(&ctx, request, &page);
    if (status.ok()) return page;
    std::cerr << "FetchPage for " << connector_id << " failed with " << status.error_code() << " (attempt " << attempt + 1 << "), retrying\\n";
  }
  throw VendorUnavailable("FetchPage failed " + std::to_string(kMaxAttempts) + " times");
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

#include "hub/store.h"  // store::get, disable
#include "vendor.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 5;
constexpr std::chrono::milliseconds kBackoffBase{250};
constexpr std::chrono::milliseconds kBackoffMax{8000};
constexpr long kBreakerFailures = 5;
constexpr long kBreakerCooldownS = 30;

auto vendor = hub::Vendor::NewStub(grpc::CreateChannel("vendor:9000", grpc::InsecureChannelCredentials()));
sw::redis::Redis redis("tcp://redis:6379");

// The vendor rejected the connector's OAuth token: the connector stays disabled until a human fixes it.
struct VendorAuthFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The vendor failed or did not answer in time: the next scheduled run tries again.
struct VendorUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// Too many consecutive failures: the vendor is left alone until the cooldown ends.
struct BreakerOpen : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string healthKey(const std::string& connector_id) { return "health:" + connector_id; }

long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

// Half to all of the exponential ceiling: retries spread out instead of arriving together.
std::chrono::milliseconds backoff(int attempt) {
  static std::mt19937 rng(static_cast<unsigned>(nowS()));
  const std::chrono::milliseconds ceiling = std::min(kBackoffMax, kBackoffBase * (1 << attempt));
  std::uniform_int_distribution<long long> jitter(0, ceiling.count() / 2);
  return ceiling / 2 + std::chrono::milliseconds(jitter(rng));
}

void recordFailure(const std::string& connector_id) {
  const long long failures = redis.hincrby(healthKey(connector_id), "consecutive_failures", 1);
  redis.hset(healthKey(connector_id), "last_run_at", std::to_string(nowS()));
  if (failures >= kBreakerFailures) redis.hset(healthKey(connector_id), "open_until", std::to_string(nowS() + kBreakerCooldownS));
}

void recordSuccess(const std::string& connector_id) {
  redis.hset(healthKey(connector_id), {{"consecutive_failures", "0"}, {"open_until", "0"}, {"last_run_at", std::to_string(nowS())}});
}

// One page of the connector's records, starting at cursor.
hub::Page fetchPage(const std::string& connector_id, const std::string& cursor) {
  const auto connector = store::get(connector_id);
  if (!connector) throw std::out_of_range("no connector " + connector_id);
  if (connector->status == "disabled") throw VendorAuthFailed(connector->disabled_reason);
  const auto open_until = redis.hget(healthKey(connector_id), "open_until");
  if (open_until && !open_until->empty() && nowS() < std::stol(*open_until)) throw BreakerOpen(connector_id + ": the vendor breaker is open");
  hub::FetchPageRequest request;
  request.set_connector_id(connector_id);
  request.set_cursor(cursor);
  request.set_token_ref(connector->token_ref);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    hub::Page page;
    const grpc::Status status = vendor->FetchPage(&ctx, request, &page);
    if (status.ok()) {
      recordSuccess(connector_id);
      return page;
    }
    if (status.error_code() == grpc::StatusCode::UNAUTHENTICATED) {
      // Retrying cannot fix a revoked token: stop the connector where an operator sees why.
      store::disable(connector_id, "vendor rejected the OAuth token (401)");
      throw VendorAuthFailed(status.error_message());
    }
    if (status.error_code() == grpc::StatusCode::RESOURCE_EXHAUSTED) {
      if (attempt + 1 < kMaxAttempts) std::this_thread::sleep_for(backoff(attempt));
      continue;
    }
    // A 5xx or a deadline: the scheduler runs again later; the breaker stops the runs piling up.
    recordFailure(connector_id);
    throw VendorUnavailable("FetchPage: " + status.error_message());
  }
  throw VendorUnavailable("FetchPage: still rate limited after " + std::to_string(kMaxAttempts) + " attempts");
}
`,
    },
  },
  harness: {
    python: `import grpc

import vendor_pb2
import vendor_pb2_grpc
from hub import store


class Vendor(vendor_pb2_grpc.VendorServicer):
    """Two records a page; the next cursor is the page's cursor plus one."""

    def FetchPage(self, request, context):
        n = int(request.cursor or 0)
        records = [vendor_pb2.SourceRecord(id=f"r-{n}-{i}", body=f"record {i} of page {n}") for i in range(2)]
        return vendor_pb2.Page(records=records, next_cursor=str(n + 1))


def _client(ctx):
    ctx.grpc.serve(vendor_pb2_grpc.add_VendorServicer_to_server, Vendor())
    m = ctx.load("client")
    connector = store.create("acme", "github", "api.github.com", "vault:acme/github#4", 900)
    return m, connector["connector_id"]


def _fetch(m, connector_id, cursor="0"):
    """fetch_page, reporting what it raised instead of ending the check."""
    try:
        return m.fetch_page(connector_id, cursor), None
    except Exception as exc:  # noqa: BLE001
        return None, exc


def _did(page, err):
    return f"raised {type(err).__name__}: {err}" if err is not None else f"returned a page (next_cursor {page.next_cursor!r})"


def _calls(ctx):
    return ctx.grpc.calls_to("FetchPage")


def check_deadline(ctx):
    m, cid = _client(ctx)
    page, err = _fetch(m, cid)
    assert err is None and page.next_cursor == "1", f"with a healthy vendor fetch_page raised {err!r}"
    call = _calls(ctx)[-1]
    assert call.timeout is not None, "FetchPage carries no deadline: a vendor that stops answering holds the worker for as long as it likes"
    assert 1.5 <= call.timeout <= 2.5, f"FetchPage carries a {call.timeout} s deadline, expected DEADLINE_S = 2"
    ctx.grpc.set_latency("FetchPage", 30.0)
    started = ctx.clock.time()
    page, err = _fetch(m, cid, "1")
    waited = ctx.clock.time() - started
    assert isinstance(err, m.VendorUnavailable), f"with the vendor 30 s slow fetch_page {_did(page, err)} after {waited:.1f} s, expected VendorUnavailable after the 2 s deadline"
    assert waited <= 3, f"fetch_page waited {waited:.1f} s on a stalled vendor"
    health = ctx.redis.hgetall(f"health:{cid}")
    assert health.get("consecutive_failures") == "1", f"a deadline must count toward the breaker: health:{cid} holds {health}"


def check_backoff(ctx):
    m, cid = _client(ctx)
    ctx.grpc.fail("FetchPage", grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limited", times=3)
    page, err = _fetch(m, cid)
    calls = _calls(ctx)
    assert err is None and page is not None, f"three 429s then an answer: fetch_page raised {err!r}, it must back off and retry a rate limit"
    assert len(calls) == 4, f"three 429s then an answer took {len(calls)} calls, expected 4"
    gaps = [round(b.started - a.started, 3) for a, b in zip(calls, calls[1:])]
    assert gaps[0] >= 0.1, f"the retries came {gaps} s apart: retrying a 429 at once is the flood the vendor asked you to stop"
    assert gaps[2] > 1.5 * gaps[0], f"the waits between retries were {gaps} s: they must grow with the attempt (BACKOFF_BASE_S doubling)"
    ctx.grpc.fail("FetchPage", grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limited", times=5)
    page, err = _fetch(m, cid, "1")
    made = len(_calls(ctx)) - 4
    assert isinstance(err, m.VendorUnavailable), f"a vendor answering 429 to every attempt: fetch_page {_did(page, err)}, expected VendorUnavailable"
    assert made == 5, f"a vendor answering 429 to every attempt was called {made} times, expected MAX_ATTEMPTS = 5"


def check_auth_terminal(ctx):
    m, cid = _client(ctx)
    ctx.grpc.fail("FetchPage", grpc.StatusCode.UNAUTHENTICATED, "token revoked", times=5)
    page, err = _fetch(m, cid)
    calls = len(_calls(ctx))
    assert isinstance(err, m.VendorAuthFailed), f"after a 401 fetch_page {_did(page, err)}, expected VendorAuthFailed"
    assert calls == 1, f"a rejected token was sent to the vendor {calls} times: a 401 does not get better by retrying"
    row = store.get(cid)
    assert row["status"] == "disabled" and row["disabled_reason"], f"after a 401 the connector is {row['status']!r} with reason {row['disabled_reason']!r}: disable it with a reason an operator can read"
    page, err = _fetch(m, cid, "1")
    assert isinstance(err, m.VendorAuthFailed), f"a disabled connector: fetch_page {_did(page, err)}, expected VendorAuthFailed"
    assert len(_calls(ctx)) == 1, "a disabled connector called the vendor again"


def check_breaker(ctx):
    m, cid = _client(ctx)
    ctx.grpc.fail("FetchPage", grpc.StatusCode.UNAVAILABLE, "vendor 503", times=5)
    for run in range(1, 6):
        page, err = _fetch(m, cid, str(run))
        assert isinstance(err, m.VendorUnavailable), f"run {run} against a vendor answering 503: fetch_page {_did(page, err)}, expected VendorUnavailable"
    assert len(_calls(ctx)) == 5, f"five runs against a vendor answering 503 made {len(_calls(ctx))} calls, expected one a run: a 5xx goes back to the scheduler"
    health = ctx.redis.hgetall(f"health:{cid}")
    assert health.get("consecutive_failures") == "5", f"health:{cid} holds {health}, expected consecutive_failures 5"
    assert int(health.get("open_until") or 0) > ctx.clock.time(), f"after five consecutive failures health:{cid} holds {health}: open_until must lie BREAKER_COOLDOWN_S ahead"
    page, err = _fetch(m, cid, "6")
    assert isinstance(err, m.BreakerOpen), f"the sixth run after five consecutive failures: fetch_page {_did(page, err)}, expected BreakerOpen"
    assert len(_calls(ctx)) == 5, "with the breaker open the vendor was called"
    ctx.clock.advance(31)
    page, err = _fetch(m, cid, "6")
    assert err is None and page is not None, f"31 s later a recovered vendor must be tried again: fetch_page raised {err!r}"
    health = ctx.redis.hgetall(f"health:{cid}")
    assert health.get("consecutive_failures") == "0", f"a success must reset the failure count, health:{cid} holds {health}"
`,
    typescript: `async function client(ctx) {
  const pkg = ctx.proto('vendor.proto');
  ctx.grpc.serve(pkg.hub.Vendor.service, {
    FetchPage(call, callback) {
      const n = Number(call.request.cursor || 0);
      const records = [0, 1].map(i => ({id: \`r-\${n}-\${i}\`, body: \`record \${i} of page \${n}\`}));
      callback(null, {records, next_cursor: String(n + 1)});
    },
  });
  const m = ctx.load('client');
  const store = ctx.load('/support/hub/store.ts');
  const connector = await store.create('acme', 'github', 'api.github.com', 'vault:acme/github#4', 900);
  return {m, store, cid: connector.connector_id};
}

/** fetchPage, reporting what it threw instead of ending the check. */
async function fetch(m, connectorId: string, cursor = '0') {
  try {
    return {page: await m.fetchPage(connectorId, cursor), err: null};
  } catch (e) {
    return {page: null, err: e};
  }
}

const calls = ctx => ctx.grpc.callsTo('FetchPage');
const named = (err): string => (err === null ? 'nothing' : \`\${err.constructor?.name}: \${err.message}\`);

export async function check_deadline(ctx) {
  const {m, cid} = await client(ctx);
  let {page, err} = await fetch(m, cid);
  assert(err === null && page.next_cursor === '1', \`with a healthy vendor fetchPage threw \${named(err)}\`);
  const call = calls(ctx).at(-1);
  assert(call.timeout !== null, 'FetchPage carries no deadline: a vendor that stops answering holds the worker for as long as it likes');
  assert(1.5 <= call.timeout && call.timeout <= 2.5, \`FetchPage carries a \${call.timeout} s deadline, expected DEADLINE_MS = 2000\`);
  ctx.grpc.setLatency('FetchPage', 30.0);
  const started = ctx.clock.now();
  ({page, err} = await fetch(m, cid, '1'));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(err instanceof m.VendorUnavailable, \`with the vendor 30 s slow fetchPage threw \${named(err)} after \${waited} s, expected VendorUnavailable after the 2 s deadline\`);
  assert(waited <= 3, \`fetchPage waited \${waited} s on a stalled vendor\`);
  const health = ctx.redis.hgetall(\`health:\${cid}\`);
  assert.equal(health.consecutive_failures, '1', \`a deadline must count toward the breaker: health:\${cid} holds \${JSON.stringify(health)}\`);
}

export async function check_backoff(ctx) {
  const {m, cid} = await client(ctx);
  ctx.grpc.fail('FetchPage', ctx.grpc.status.RESOURCE_EXHAUSTED, 'rate limited', 3);
  let {page, err} = await fetch(m, cid);
  const made = calls(ctx);
  assert(err === null && page !== null, \`three 429s then an answer: fetchPage threw \${named(err)}, it must back off and retry a rate limit\`);
  assert.equal(made.length, 4, \`three 429s then an answer took \${made.length} calls, expected 4\`);
  const gaps = made.slice(1).map((c, i) => (c.started - made[i].started) / 1000);
  assert(gaps[0] >= 0.1, \`the retries came \${JSON.stringify(gaps)} s apart: retrying a 429 at once is the flood the vendor asked you to stop\`);
  assert(gaps[2] > 1.5 * gaps[0], \`the waits between retries were \${JSON.stringify(gaps)} s: they must grow with the attempt (BACKOFF_BASE_S doubling)\`);
  ctx.grpc.fail('FetchPage', ctx.grpc.status.RESOURCE_EXHAUSTED, 'rate limited', 5);
  ({page, err} = await fetch(m, cid, '1'));
  assert(err instanceof m.VendorUnavailable, \`a vendor answering 429 to every attempt: fetchPage threw \${named(err)}, expected VendorUnavailable\`);
  assert.equal(calls(ctx).length - 4, 5, \`a vendor answering 429 to every attempt was called \${calls(ctx).length - 4} times, expected MAX_ATTEMPTS = 5\`);
}

export async function check_auth_terminal(ctx) {
  const {m, store, cid} = await client(ctx);
  ctx.grpc.fail('FetchPage', ctx.grpc.status.UNAUTHENTICATED, 'token revoked', 5);
  let {err} = await fetch(m, cid);
  assert(err instanceof m.VendorAuthFailed, \`after a 401 fetchPage threw \${named(err)}, expected VendorAuthFailed\`);
  assert.equal(calls(ctx).length, 1, \`a rejected token was sent to the vendor \${calls(ctx).length} times: a 401 does not get better by retrying\`);
  const row = await store.get(cid);
  assert(row.status === 'disabled' && row.disabled_reason !== '', \`after a 401 the connector is \${row.status} with reason "\${row.disabled_reason}": disable it with a reason an operator can read\`);
  ({err} = await fetch(m, cid, '1'));
  assert(err instanceof m.VendorAuthFailed, \`a disabled connector: fetchPage threw \${named(err)}, expected VendorAuthFailed\`);
  assert.equal(calls(ctx).length, 1, 'a disabled connector called the vendor again');
}

export async function check_breaker(ctx) {
  const {m, cid} = await client(ctx);
  ctx.grpc.fail('FetchPage', ctx.grpc.status.UNAVAILABLE, 'vendor 503', 5);
  for (let run = 1; run <= 5; run += 1) {
    const {err} = await fetch(m, cid, String(run));
    assert(err instanceof m.VendorUnavailable, \`run \${run} against a vendor answering 503: fetchPage threw \${named(err)}, expected VendorUnavailable\`);
  }
  assert.equal(calls(ctx).length, 5, \`five runs against a vendor answering 503 made \${calls(ctx).length} calls, expected one a run: a 5xx goes back to the scheduler\`);
  let health = ctx.redis.hgetall(\`health:\${cid}\`);
  assert.equal(health.consecutive_failures, '5', \`health:\${cid} holds \${JSON.stringify(health)}, expected consecutive_failures 5\`);
  assert(Number(health.open_until ?? 0) * 1000 > ctx.clock.now(), \`after five consecutive failures health:\${cid} holds \${JSON.stringify(health)}: open_until must lie BREAKER_COOLDOWN_S ahead\`);
  let {page, err} = await fetch(m, cid, '6');
  assert(err instanceof m.BreakerOpen, \`the sixth run after five consecutive failures: fetchPage threw \${named(err)}, expected BreakerOpen\`);
  assert.equal(calls(ctx).length, 5, 'with the breaker open the vendor was called');
  ctx.clock.advance(31);
  ({page, err} = await fetch(m, cid, '6'));
  assert(err === null && page !== null, \`31 s later a recovered vendor must be tried again: fetchPage threw \${named(err)}\`);
  health = ctx.redis.hgetall(\`health:\${cid}\`);
  assert.equal(health.consecutive_failures, '0', \`a success must reset the failure count, health:\${cid} holds \${JSON.stringify(health)}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	pb "hub/gen/vendor"
	"hub/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

// vendorPeer serves two records a page; the next cursor is the page's cursor plus one.
type vendorPeer struct {
	pb.UnimplementedVendorServer
}

func (vendorPeer) FetchPage(_ context.Context, req *pb.FetchPageRequest) (*pb.Page, error) {
	n, _ := strconv.Atoi(req.GetCursor())
	records := []*pb.SourceRecord{
		{Id: fmt.Sprintf("r-%d-0", n), Body: fmt.Sprintf("record 0 of page %d", n)},
		{Id: fmt.Sprintf("r-%d-1", n), Body: fmt.Sprintf("record 1 of page %d", n)},
	}
	return &pb.Page{Records: records, NextCursor: strconv.Itoa(n + 1)}, nil
}

func client(ctx *harness.Ctx) string {
	pb.RegisterVendorServer(ctx.GRPC.Server(""), vendorPeer{})
	return store.Create(clientBg, "acme", "github", "api.github.com", "vault:acme/github#4", 900).ConnectorID
}

// fetch is fetchPage, reporting a panic as an error instead of ending the check.
func fetch(connectorID, cursor string) (page *pb.Page, err error) {
	defer func() {
		if e := recover(); e != nil {
			err = errors.New("panic: " + harness.Show(e))
		}
	}()
	return fetchPage(clientBg, connectorID, cursor)
}

func fetchCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("FetchPage", "") }

func CheckDeadline(ctx *harness.Ctx) {
	cid := client(ctx)
	page, err := fetch(cid, "0")
	ctx.Assert(err == nil && page.GetNextCursor() == "1", "with a healthy vendor fetchPage failed: %v", err)
	calls := fetchCalls(ctx)
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "FetchPage carries no deadline: a vendor that stops answering holds the worker for as long as it likes")
	ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "FetchPage carries a %v deadline, expected 2 s", call.Timeout)
	ctx.GRPC.SetLatency("FetchPage", 30.0, "")
	started := ctx.Clock.Now()
	_, err = fetch(cid, "1")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(errors.Is(err, ErrVendorUnavailable), "with the vendor 30 s slow fetchPage returned %v after %.1f s, expected ErrVendorUnavailable after the 2 s deadline", err, waited)
	ctx.Assert(waited <= 3, "fetchPage waited %.1f s on a stalled vendor", waited)
	failures, _ := ctx.Redis.HGet("health:"+cid, "consecutive_failures")
	ctx.Equal(failures, "1", "a deadline must count toward the breaker; health:%s consecutive_failures", cid)
}

func CheckBackoff(ctx *harness.Ctx) {
	cid := client(ctx)
	ctx.GRPC.Fail("FetchPage", codes.ResourceExhausted, "rate limited", 3, "")
	page, err := fetch(cid, "0")
	calls := fetchCalls(ctx)
	ctx.Assert(err == nil && page != nil, "three 429s then an answer: fetchPage returned %v, it must back off and retry a rate limit", err)
	ctx.Equal(len(calls), 4, "three 429s then an answer; the calls")
	var gaps []float64
	for i := 1; i < len(calls); i++ {
		gaps = append(gaps, calls[i].Started.Sub(calls[i-1].Started).Seconds())
	}
	ctx.Assert(gaps[0] >= 0.1, "the retries came %v s apart: retrying a 429 at once is the flood the vendor asked you to stop", gaps)
	ctx.Assert(gaps[2] > 1.5*gaps[0], "the waits between retries were %v s: they must grow with the attempt (backoffBase doubling)", gaps)
	ctx.GRPC.Fail("FetchPage", codes.ResourceExhausted, "rate limited", 5, "")
	_, err = fetch(cid, "1")
	ctx.Assert(errors.Is(err, ErrVendorUnavailable), "a vendor answering 429 to every attempt: fetchPage returned %v, expected ErrVendorUnavailable", err)
	ctx.Equal(len(fetchCalls(ctx))-4, 5, "a vendor answering 429 to every attempt; the calls (maxAttempts)")
}

func CheckAuthTerminal(ctx *harness.Ctx) {
	cid := client(ctx)
	ctx.GRPC.Fail("FetchPage", codes.Unauthenticated, "token revoked", 5, "")
	_, err := fetch(cid, "0")
	ctx.Assert(errors.Is(err, ErrVendorAuthFailed), "after a 401 fetchPage returned %v, expected ErrVendorAuthFailed", err)
	ctx.Equal(len(fetchCalls(ctx)), 1, "a 401 does not get better by retrying; the calls with a rejected token")
	row := store.Get(clientBg, cid)
	ctx.Assert(row.Status == "disabled" && row.DisabledReason != "", "after a 401 the connector is %q with reason %q: disable it with a reason an operator can read", row.Status, row.DisabledReason)
	_, err = fetch(cid, "1")
	ctx.Assert(errors.Is(err, ErrVendorAuthFailed), "a disabled connector: fetchPage returned %v, expected ErrVendorAuthFailed", err)
	ctx.Equal(len(fetchCalls(ctx)), 1, "a disabled connector must not call the vendor again; the calls")
}

func CheckBreaker(ctx *harness.Ctx) {
	cid := client(ctx)
	ctx.GRPC.Fail("FetchPage", codes.Unavailable, "vendor 503", 5, "")
	for run := 1; run <= 5; run++ {
		_, err := fetch(cid, strconv.Itoa(run))
		ctx.Assert(errors.Is(err, ErrVendorUnavailable), "run %d against a vendor answering 503: fetchPage returned %v, expected ErrVendorUnavailable", run, err)
	}
	ctx.Equal(len(fetchCalls(ctx)), 5, "five runs against a vendor answering 503 must make one call a run (a 5xx goes back to the scheduler); the calls")
	health := ctx.Redis.HGetAll("health:" + cid)
	ctx.Equal(health["consecutive_failures"], "5", "health:%s consecutive_failures (it holds %v)", cid, health)
	openUntil, _ := strconv.ParseInt(health["open_until"], 10, 64)
	ctx.Assert(openUntil*1000 > ctx.Clock.Now(), "after five consecutive failures health:%s holds %v: open_until must lie breakerCooldownS ahead", cid, health)
	_, err := fetch(cid, "6")
	ctx.Assert(errors.Is(err, ErrBreakerOpen), "the sixth run after five consecutive failures: fetchPage returned %v, expected ErrBreakerOpen", err)
	ctx.Equal(len(fetchCalls(ctx)), 5, "with the breaker open the vendor must not be called; the calls")
	ctx.Clock.Advance(31)
	page, err := fetch(cid, "6")
	ctx.Assert(err == nil && page != nil, "31 s later a recovered vendor must be tried again: fetchPage returned %v", err)
	failures, _ := ctx.Redis.HGet("health:"+cid, "consecutive_failures")
	ctx.Equal(failures, "0", "a success must reset the failure count; consecutive_failures")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <string>
#include <vector>

namespace {

// Two records a page; the next cursor is the page's cursor plus one.
class VendorPeer final : public hub::Vendor::Service {
 public:
  grpc::Status FetchPage(grpc::ServerContext*, const hub::FetchPageRequest* req, hub::Page* out) override {
    const long n = req->cursor().empty() ? 0 : std::stol(req->cursor());
    for (int i = 0; i < 2; i++) {
      hub::SourceRecord* record = out->add_records();
      record->set_id("r-" + std::to_string(n) + "-" + std::to_string(i));
      record->set_body("record " + std::to_string(i) + " of page " + std::to_string(n));
    }
    out->set_next_cursor(std::to_string(n + 1));
    return grpc::Status::OK;
  }
};

std::string client(harness::Ctx& ctx) {
  static VendorPeer* peer = nullptr;
  delete peer;
  peer = new VendorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return store::create("acme", "github", "api.github.com", "vault:acme/github#4", 900).connector_id;
}

// What fetchPage did: the exception it threw ("" when it returned) and the page's next cursor.
struct Outcome {
  std::string thrown;
  std::string next_cursor;
};

Outcome fetch(const std::string& connector_id, const std::string& cursor) {
  try {
    const hub::Page page = fetchPage(connector_id, cursor);
    return {"", page.next_cursor()};
  } catch (const VendorAuthFailed&) {
    return {"VendorAuthFailed", ""};
  } catch (const VendorUnavailable&) {
    return {"VendorUnavailable", ""};
  } catch (const BreakerOpen&) {
    return {"BreakerOpen", ""};
  } catch (const std::exception& e) {
    return {std::string(harness::CurrentExceptionType()) + ": " + e.what(), ""};
  }
}

double seconds(std::chrono::system_clock::duration d) { return std::chrono::duration<double>(d).count(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  const std::string cid = client(ctx);
  Outcome out = fetch(cid, "0");
  ctx.Assert(out.thrown.empty() && out.next_cursor == "1", "with a healthy vendor fetchPage threw %s", out.thrown);
  const auto calls = ctx.GRPC.CallsTo("FetchPage");
  const auto& call = calls.back();
  ctx.Assert(call.HasDeadline(), "FetchPage carries no deadline: a vendor that stops answering holds the worker for as long as it likes");
  ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "FetchPage carries a %v s deadline, expected kDeadline = 2 s", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("FetchPage", 30.0);
  const int64_t started = ctx.Clock.Now();
  out = fetch(cid, "1");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Equal(out.thrown, "VendorUnavailable", "with the vendor 30 s slow (waited %v s), fetchPage must throw VendorUnavailable after the 2 s deadline; it threw", waited);
  ctx.Assert(waited <= 3, "fetchPage waited %v s on a stalled vendor", waited);
  ctx.Equal(ctx.Redis.HGet("health:" + cid, "consecutive_failures").value_or(""), "1", "a deadline must count toward the breaker; consecutive_failures");
}

void CheckBackoff(harness::Ctx& ctx) {
  const std::string cid = client(ctx);
  ctx.GRPC.Fail("FetchPage", grpc::StatusCode::RESOURCE_EXHAUSTED, "rate limited", 3);
  Outcome out = fetch(cid, "0");
  const auto calls = ctx.GRPC.CallsTo("FetchPage");
  ctx.Assert(out.thrown.empty(), "three 429s then an answer: fetchPage threw %s, it must back off and retry a rate limit", out.thrown);
  ctx.Equal(calls.size(), 4, "three 429s then an answer; the calls");
  std::vector<double> gaps;
  for (size_t i = 1; i < calls.size(); i++) gaps.push_back(seconds(calls[i].Started - calls[i - 1].Started));
  ctx.Assert(gaps[0] >= 0.1, "the retries came %v s apart: retrying a 429 at once is the flood the vendor asked you to stop", gaps);
  ctx.Assert(gaps[2] > 1.5 * gaps[0], "the waits between retries were %v s: they must grow with the attempt (kBackoffBase doubling)", gaps);
  ctx.GRPC.Fail("FetchPage", grpc::StatusCode::RESOURCE_EXHAUSTED, "rate limited", 5);
  out = fetch(cid, "1");
  ctx.Equal(out.thrown, "VendorUnavailable", "a vendor answering 429 to every attempt; fetchPage threw");
  ctx.Equal(ctx.GRPC.CallsTo("FetchPage").size() - 4, 5, "a vendor answering 429 to every attempt; the calls (kMaxAttempts)");
}

void CheckAuthTerminal(harness::Ctx& ctx) {
  const std::string cid = client(ctx);
  ctx.GRPC.Fail("FetchPage", grpc::StatusCode::UNAUTHENTICATED, "token revoked", 5);
  Outcome out = fetch(cid, "0");
  ctx.Equal(out.thrown, "VendorAuthFailed", "after a 401, fetchPage threw");
  ctx.Equal(ctx.GRPC.CallsTo("FetchPage").size(), 1, "a 401 does not get better by retrying; the calls with a rejected token");
  const auto row = store::get(cid);
  ctx.Assert(row->status == "disabled" && !row->disabled_reason.empty(), "after a 401 the connector is %q with reason %q: disable it with a reason an operator can read", row->status, row->disabled_reason);
  out = fetch(cid, "1");
  ctx.Equal(out.thrown, "VendorAuthFailed", "a disabled connector; fetchPage threw");
  ctx.Equal(ctx.GRPC.CallsTo("FetchPage").size(), 1, "a disabled connector must not call the vendor again; the calls");
}

void CheckBreaker(harness::Ctx& ctx) {
  const std::string cid = client(ctx);
  ctx.GRPC.Fail("FetchPage", grpc::StatusCode::UNAVAILABLE, "vendor 503", 5);
  for (int run = 1; run <= 5; run++) {
    const Outcome out = fetch(cid, std::to_string(run));
    ctx.Equal(out.thrown, "VendorUnavailable", "run %d against a vendor answering 503; fetchPage threw", run);
  }
  ctx.Equal(ctx.GRPC.CallsTo("FetchPage").size(), 5, "five runs against a vendor answering 503 must make one call a run (a 5xx goes back to the scheduler); the calls");
  const auto health = ctx.Redis.HGetAll("health:" + cid);
  const auto field = [&health](const std::string& f) { return health.count(f) ? health.at(f) : std::string(); };
  ctx.Equal(field("consecutive_failures"), "5", "health:%s consecutive_failures (it holds %v)", cid, health);
  const long long open_until = field("open_until").empty() ? 0 : std::stoll(field("open_until"));
  ctx.Assert(open_until * 1000 > ctx.Clock.Now(), "after five consecutive failures health:%s holds %v: open_until must lie kBreakerCooldownS ahead", cid, health);
  Outcome out = fetch(cid, "6");
  ctx.Equal(out.thrown, "BreakerOpen", "the sixth run after five consecutive failures; fetchPage threw");
  ctx.Equal(ctx.GRPC.CallsTo("FetchPage").size(), 5, "with the breaker open the vendor must not be called; the calls");
  ctx.Clock.Advance(31);
  out = fetch(cid, "6");
  ctx.Assert(out.thrown.empty(), "31 s later a recovered vendor must be tried again: fetchPage threw %s", out.thrown);
  ctx.Equal(ctx.Redis.HGet("health:" + cid, "consecutive_failures").value_or(""), "0", "a success must reset the failure count; consecutive_failures");
}
`,
  },
  hints: [
    'Make the vendor answer 429 three times: the four calls land in the same instant. Answer 401: five calls, and the connector still reads enabled. Answer 503 forever: every run calls five times.',
    'The loop treats every status alike and never waits, carries no deadline, and keeps no memory between runs, so a revoked token and a vendor outage cost the same as a blip, forever.',
    'Pass `timeout=DEADLINE_S`; on `RESOURCE_EXHAUSTED` sleep `backoff_s(attempt)` and loop; on `UNAUTHENTICATED` call `store.disable` and raise; else `HINCRBY consecutive_failures`, set `open_until` at five, raise. Check `open_until` before calling; reset it on success.',
  ],
  debrief: `The status code decides the shape: a 429 is the vendor asking for time, so the client waits longer each attempt with jitter that keeps a fleet of workers from retrying in step; a 401 is a fact about the token, so the client stops and records why; a 5xx or a deadline is a fact about this moment, so the run ends and the breaker counts it. The breaker lives in Redis beside the health read because every worker and the operator need the same answer to "is this vendor being left alone". Production clients also honour the vendor's \`Retry-After\` when it sends one, and keep the breaker per vendor host, since one vendor's outage reaches every connector that calls it.`,
};
