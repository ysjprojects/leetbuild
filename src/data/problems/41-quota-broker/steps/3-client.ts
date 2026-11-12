import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Capacity confirmation that denies when unsure',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['broker', 'capacity', 'pool', 'redis'],
  task: `## Task

**Starting point.** The starter is the reserve path's capacity check:
\`reserve_with_capacity(team, window, resource_class, amount)\` calls the capacity service's
\`Confirm\` RPC up to five times, sleeping 200 ms after any error, then takes the units with
\`ledger.reserve\` (provided) whatever the pool said. With the pool healthy it grants; it hides five
flaws.

**Failure mode the checks target.** A stalled capacity service holds every reserve open; a pool that
answered "full" is asked four more times and the units are granted anyway; a pool that never
answered counts as a yes; and a grant cannot be traced to the pool generation it was checked against.

\`\`\`proto
service Capacity { rpc Confirm(ConfirmRequest) returns (ConfirmReply); }  // RESOURCE_EXHAUSTED: no room
\`\`\`

- Every \`Confirm\` carries a \`DEADLINE_S\` = 0.25 s deadline.
- \`confirm_capacity(...)\` makes at most \`MAX_ATTEMPTS\` = 2 attempts and retries only the codes in
  \`RETRIABLE\` (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`).
- \`RESOURCE_EXHAUSTED\` raises \`CapacityExhausted\` at once (the handler's 409).
- Any other failure, or the last attempt failing, raises \`CapacityUnavailable\` (the handler's 503
  \`TRY_AGAIN\`) with the ledger untouched: \`confirm_capacity\` runs before \`ledger.reserve\`.
- Pass the reply's \`source_version\` to \`ledger.reserve\`, which records it on the reservation.`,
  sequence: {
    participants: ['Quota Broker', 'Capacity service', 'Redis'],
    messages: [
      {
        from: 'Quota Broker',
        to: 'Capacity service',
        label: 'Confirm(team, window, class, amount) · deadline 250 ms',
        kind: 'sync',
      },
      {
        from: 'Capacity service',
        to: 'Quota Broker',
        label: 'UNAVAILABLE · DEADLINE_EXCEEDED → one more attempt',
        kind: 'reply',
      },
      {
        from: 'Capacity service',
        to: 'Quota Broker',
        label: 'RESOURCE_EXHAUSTED → CapacityExhausted, no retry',
        kind: 'reply',
      },
      {from: 'Capacity service', to: 'Quota Broker', label: 'ConfirmReply{source_version}', kind: 'reply'},
      {
        from: 'Quota Broker',
        to: 'Redis',
        label: 'ledger.reserve(…, source_version) only after a confirmation',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Confirm carries a 250 ms deadline',
      detail:
        'Each `Confirm` call is made with `DEADLINE_S` (0.25 s); the starter sets none, so a capacity service that stops answering holds every reserve open.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.25\b/, /Confirm\([\s\S]{0,160}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*250\b/, /Confirm\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*250\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineMillis\s*=\s*250L?\b/, /withDeadlineAfter\(\s*DeadlineMillis/]},
        cpp: {all: [/kDeadline\{250\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries UNAVAILABLE and DEADLINE_EXCEEDED, twice at most',
      detail:
        'One `UNAVAILABLE` is followed by exactly one more attempt; a pool that stays down gets `MAX_ATTEMPTS` (2) calls, not five, and no sleep stretches the reserve.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /RETRIABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/range\(5\)/, /while\s+True/, /time\.sleep\(/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /RETRIABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /setTimeout\(/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2\b/, /retriable/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/attempt < 5/, /time\.Sleep\(/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*2\b/, /Retriable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /Thread\.sleep\(/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*2\b/, /kRetriable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /sleep_for\(/],
        },
      },
    },
    {
      id: 'exhausted-terminal',
      title: 'A full pool is CapacityExhausted after one call',
      detail:
        '`RESOURCE_EXHAUSTED` raises `CapacityExhausted` after a single `Confirm` and writes nothing; the starter asks again four times, then grants the units anyway.',
      match: {
        python: {all: [/RESOURCE_EXHAUSTED/, /raise CapacityExhausted/]},
        typescript: {all: [/RESOURCE_EXHAUSTED/, /throw new CapacityExhausted/]},
        go: {all: [/codes\.ResourceExhausted/, /return[^\n]*ErrCapacityExhausted/]},
        scala: {all: [/RESOURCE_EXHAUSTED/, /throw new CapacityExhausted/]},
        cpp: {all: [/RESOURCE_EXHAUSTED/, /throw CapacityExhausted/]},
      },
    },
    {
      id: 'deny-when-unsure',
      title: 'No confirmation, no grant',
      detail:
        'A capacity service slower than the deadline makes the reserve raise `CapacityUnavailable` within a second and leaves the ledger untouched: `confirm_capacity` runs before `ledger.reserve`. The starter reserves whatever the pool said.',
      match: {
        python: {
          all: [/raise CapacityUnavailable/],
          order: [/def reserve_with_capacity/, /confirm_capacity\(/, /ledger\.reserve\(/],
        },
        typescript: {
          all: [/throw new CapacityUnavailable/],
          order: [/function reserveWithCapacity/, /confirmCapacity\(/, /\breserve\(/],
        },
        go: {
          all: [/return[^\n]*ErrCapacityUnavailable/],
          order: [/func reserveWithCapacity/, /confirmCapacity\(/, /ledger\.Reserve\(/],
        },
        scala: {
          all: [/throw new CapacityUnavailable/],
          order: [/def reserveWithCapacity/, /confirmCapacity\(/, /Ledger\.reserve\(/],
        },
        cpp: {
          all: [/throw CapacityUnavailable/],
          order: [/reserveWithCapacity\(/, /confirmCapacity\(/, /ledger::reserve\(/],
        },
      },
    },
    {
      id: 'source-version',
      title: 'Records the confirmed source_version',
      detail:
        'The reservation a confirmed reserve writes carries the `source_version` of the `ConfirmReply`; the starter drops the reply, so no grant can be traced to the pool generation that approved it.',
      match: {
        python: {all: [/ledger\.reserve\([^\n]*source_version\)/, /\.source_version\b/]},
        typescript: {all: [/\breserve\([^\n]*sourceVersion\)/, /\.source_version\b/]},
        go: {all: [/ledger\.Reserve\([^\n]*sourceVersion\)/, /GetSourceVersion\(\)|\.SourceVersion\b/]},
        scala: {all: [/Ledger\.reserve\([^\n]*sourceVersion\)/, /\.sourceVersion\b/]},
        cpp: {all: [/ledger::reserve\([^\n]*source_version\)/, /\.source_version\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import capacity_pb2
import capacity_pb2_grpc
from quota import ledger  # reserve, release, consume, limit_of

capacity = capacity_pb2_grpc.CapacityStub(grpc.insecure_channel("capacity:9000"))


class CapacityExhausted(Exception):
    """The pool has no room for the amount: the handler answers 409 capacity_exhausted."""


class CapacityUnavailable(Exception):
    """The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing."""


def reserve_with_capacity(team: str, window: str, resource_class: str, amount: int) -> str | None:
    """Confirm the amount with the capacity service, then take it from the team's window; None when the quota is spent."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = capacity_pb2.ConfirmRequest(team=team, window=window, resource_class=resource_class, amount=amount)
    for attempt in range(5):
        try:
            capacity.Confirm(request)
            break
        except grpc.RpcError:
            time.sleep(0.2)  # the pool is busy: ask again
    return ledger.reserve(team, window, resource_class, amount)
`,
      solution: `import grpc

import capacity_pb2
import capacity_pb2_grpc
from quota import ledger  # reserve, release, consume, limit_of

DEADLINE_S = 0.25
MAX_ATTEMPTS = 2
RETRIABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

capacity = capacity_pb2_grpc.CapacityStub(grpc.insecure_channel("capacity:9000"))


class CapacityExhausted(Exception):
    """The pool has no room for the amount: the handler answers 409 capacity_exhausted."""


class CapacityUnavailable(Exception):
    """The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing."""


def confirm_capacity(team: str, window: str, resource_class: str, amount: int) -> str:
    """The pool's confirmation of the amount: the source_version it was checked against."""
    request = capacity_pb2.ConfirmRequest(team=team, window=window, resource_class=resource_class, amount=amount)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return capacity.Confirm(request, timeout=DEADLINE_S).source_version
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
                raise CapacityExhausted(exc.details()) from exc  # the pool's answer, not a fault: asking again changes nothing
            if exc.code() not in RETRIABLE or attempt == MAX_ATTEMPTS:
                raise CapacityUnavailable(f"capacity: {exc.code().name}") from exc
    raise CapacityUnavailable("capacity: no attempt made")


def reserve_with_capacity(team: str, window: str, resource_class: str, amount: int) -> str | None:
    """Confirm the amount with the capacity service, then take it from the team's window; None when the quota is spent."""
    # Unsure is a no: only a confirmation reaches the ledger.
    source_version = confirm_capacity(team, window, resource_class, amount)
    return ledger.reserve(team, window, resource_class, amount, source_version)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {reserve} from 'quota/ledger';

interface ConfirmRequest {
  team: string;
  window: string;
  resource_class: string;
  amount: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('capacity.proto')) as unknown as {
  quota: {Capacity: grpc.ServiceClientConstructor};
};
const capacity = new pkg.quota.Capacity('capacity:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Confirm(request: ConfirmRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{source_version: string}>;
};

/** The pool has no room for the amount: the handler answers 409 capacity_exhausted. */
export class CapacityExhausted extends Error {}
/** The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing. */
export class CapacityUnavailable extends Error {}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Confirm the amount with the capacity service, then take it from the team's window; null when the quota is spent. */
export async function reserveWithCapacity(team: string, window: string, resourceClass: string, amount: number): Promise<string | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const request = {team, window, resource_class: resourceClass, amount};
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await capacity.Confirm(request, new grpc.Metadata(), {});
      break;
    } catch {
      await sleep(200); // the pool is busy: ask again
    }
  }
  return reserve(team, window, resourceClass, amount);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {reserve} from 'quota/ledger';

export const DEADLINE_MS = 250;
export const MAX_ATTEMPTS = 2;
export const RETRIABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface ConfirmRequest {
  team: string;
  window: string;
  resource_class: string;
  amount: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('capacity.proto')) as unknown as {
  quota: {Capacity: grpc.ServiceClientConstructor};
};
const capacity = new pkg.quota.Capacity('capacity:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Confirm(request: ConfirmRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{source_version: string}>;
};

/** The pool has no room for the amount: the handler answers 409 capacity_exhausted. */
export class CapacityExhausted extends Error {}
/** The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing. */
export class CapacityUnavailable extends Error {}

/** The pool's confirmation of the amount: the source_version it was checked against. */
export async function confirmCapacity(team: string, window: string, resourceClass: string, amount: number): Promise<string> {
  const request = {team, window, resource_class: resourceClass, amount};
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await capacity.Confirm(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return reply.source_version;
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      // The pool's answer, not a fault: asking again changes nothing.
      if (code === grpc.status.RESOURCE_EXHAUSTED) throw new CapacityExhausted(details);
      if (!RETRIABLE.has(code) || attempt === MAX_ATTEMPTS) throw new CapacityUnavailable(\`capacity: \${grpc.status[code]}\`);
    }
  }
}

/** Confirm the amount with the capacity service, then take it from the team's window; null when the quota is spent. */
export async function reserveWithCapacity(team: string, window: string, resourceClass: string, amount: number): Promise<string | null> {
  // Unsure is a no: only a confirmation reaches the ledger.
  const sourceVersion = await confirmCapacity(team, window, resourceClass, amount);
  return reserve(team, window, resourceClass, amount, sourceVersion);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"quota/ledger" // ledger.Reserve(ctx, team, window, resourceClass, amount, sourceVersion) (string, error)
	pb "quota/gen/capacity"
)

var (
	capacityConn, _ = grpc.NewClient("capacity:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	capacity        = pb.NewCapacityClient(capacityConn)
)

var (
	// ErrCapacityExhausted: the pool has no room for the amount, the handler answers 409 capacity_exhausted.
	ErrCapacityExhausted = errors.New("capacity exhausted")
	// ErrCapacityUnavailable: the pool gave no answer to rely on, the handler answers 503 TRY_AGAIN and writes nothing.
	ErrCapacityUnavailable = errors.New("capacity unavailable")
)

// reserveWithCapacity confirms the amount with the capacity service, then takes it from the team's
// window; "" when the quota is spent.
func reserveWithCapacity(ctx context.Context, team, window, resourceClass string, amount int64) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	request := &pb.ConfirmRequest{Team: team, Window: window, ResourceClass: resourceClass, Amount: amount}
	for attempt := 0; attempt < 5; attempt++ {
		if _, err := capacity.Confirm(ctx, request); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond) // the pool is busy: ask again
	}
	return ledger.Reserve(ctx, team, window, resourceClass, amount, "")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"quota/ledger" // ledger.Reserve(ctx, team, window, resourceClass, amount, sourceVersion) (string, error)
	pb "quota/gen/capacity"
)

const (
	deadline    = 250 * time.Millisecond
	maxAttempts = 2
)

var retriable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	capacityConn, _ = grpc.NewClient("capacity:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	capacity        = pb.NewCapacityClient(capacityConn)
)

var (
	// ErrCapacityExhausted: the pool has no room for the amount, the handler answers 409 capacity_exhausted.
	ErrCapacityExhausted = errors.New("capacity exhausted")
	// ErrCapacityUnavailable: the pool gave no answer to rely on, the handler answers 503 TRY_AGAIN and writes nothing.
	ErrCapacityUnavailable = errors.New("capacity unavailable")
)

// confirmCapacity is the pool's confirmation of the amount: the source_version it was checked against.
func confirmCapacity(ctx context.Context, team, window, resourceClass string, amount int64) (string, error) {
	request := &pb.ConfirmRequest{Team: team, Window: window, ResourceClass: resourceClass, Amount: amount}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := capacity.Confirm(callCtx, request)
		cancel()
		if err == nil {
			return reply.GetSourceVersion(), nil
		}
		code := status.Code(err)
		if code == codes.ResourceExhausted {
			// The pool's answer, not a fault: asking again changes nothing.
			return "", fmt.Errorf("%w: %s", ErrCapacityExhausted, status.Convert(err).Message())
		}
		if !retriable[code] || attempt == maxAttempts {
			return "", fmt.Errorf("%w: capacity: %v", ErrCapacityUnavailable, code)
		}
	}
}

// reserveWithCapacity confirms the amount with the capacity service, then takes it from the team's
// window; "" when the quota is spent.
func reserveWithCapacity(ctx context.Context, team, window, resourceClass string, amount int64) (string, error) {
	// Unsure is a no: only a confirmation reaches the ledger.
	sourceVersion, err := confirmCapacity(ctx, team, window, resourceClass, amount)
	if err != nil {
		return "", err
	}
	return ledger.Reserve(ctx, team, window, resourceClass, amount, sourceVersion)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import quota.Ledger // Ledger.reserve(team, window, resourceClass, amount, sourceVersion): Option[String]
import quota.capacity.{CapacityGrpc, ConfirmRequest}

/** The pool has no room for the amount: the handler answers 409 capacity_exhausted. */
final class CapacityExhausted(message: String) extends Exception(message)
/** The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing. */
final class CapacityUnavailable(message: String) extends Exception(message)

object Client {
  private val capacity = CapacityGrpc.blockingStub(ManagedChannelBuilder.forAddress("capacity", 9000).usePlaintext().build())

  /** Confirm the amount with the capacity service, then take it from the team's window; None when the quota is spent. */
  def reserveWithCapacity(team: String, window: String, resourceClass: String, amount: Long): Option[String] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val request = ConfirmRequest(team, window, resourceClass, amount)
    var attempt = 0
    var confirmed = false
    while (attempt < 5 && !confirmed) {
      try { capacity.confirm(request); confirmed = true }
      catch { case _: StatusRuntimeException => Thread.sleep(200); attempt += 1 } // the pool is busy: ask again
    }
    Ledger.reserve(team, window, resourceClass, amount)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import quota.Ledger // Ledger.reserve(team, window, resourceClass, amount, sourceVersion): Option[String]
import quota.capacity.{CapacityGrpc, ConfirmRequest}

/** The pool has no room for the amount: the handler answers 409 capacity_exhausted. */
final class CapacityExhausted(message: String) extends Exception(message)
/** The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing. */
final class CapacityUnavailable(message: String) extends Exception(message)

object Client {
  val DeadlineMillis = 250L
  val MaxAttempts = 2
  val Retriable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val capacity = CapacityGrpc.blockingStub(ManagedChannelBuilder.forAddress("capacity", 9000).usePlaintext().build())

  /** The pool's confirmation of the amount: the source_version it was checked against. */
  def confirmCapacity(team: String, window: String, resourceClass: String, amount: Long): String = {
    val request = ConfirmRequest(team, window, resourceClass, amount)
    def attempt(n: Int): String =
      try capacity.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).confirm(request).sourceVersion
      catch {
        // The pool's answer, not a fault: asking again changes nothing.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.RESOURCE_EXHAUSTED =>
          throw new CapacityExhausted(Option(e.getStatus.getDescription).getOrElse("no room"))
        case e: StatusRuntimeException if Retriable.contains(e.getStatus.getCode) && n < MaxAttempts => attempt(n + 1)
        case e: StatusRuntimeException => throw new CapacityUnavailable(s"capacity: \${e.getStatus.getCode}")
      }
    attempt(1)
  }

  /** Confirm the amount with the capacity service, then take it from the team's window; None when the quota is spent. */
  def reserveWithCapacity(team: String, window: String, resourceClass: String, amount: Long): Option[String] = {
    // Unsure is a no: only a confirmation reaches the ledger.
    val sourceVersion = confirmCapacity(team, window, resourceClass, amount)
    Ledger.reserve(team, window, resourceClass, amount, sourceVersion)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include "capacity.grpc.pb.h"
#include "quota/ledger.h"  // ledger::reserve(team, window, resource_class, amount, source_version)

auto capacity = quota::Capacity::NewStub(grpc::CreateChannel("capacity:9000", grpc::InsecureChannelCredentials()));

// The pool has no room for the amount: the handler answers 409 capacity_exhausted.
struct CapacityExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing.
struct CapacityUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Confirm the amount with the capacity service, then take it from the team's window; none when the quota is spent.
std::optional<std::string> reserveWithCapacity(const std::string& team, const std::string& window, const std::string& resource_class,
                                               long long amount) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  quota::ConfirmRequest request;
  request.set_team(team);
  request.set_window(window);
  request.set_resource_class(resource_class);
  request.set_amount(amount);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    quota::ConfirmReply reply;
    if (capacity->Confirm(&ctx, request, &reply).ok()) break;
    std::this_thread::sleep_for(std::chrono::milliseconds{200});  // the pool is busy: ask again
  }
  return ledger::reserve(team, window, resource_class, amount);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>

#include "capacity.grpc.pb.h"
#include "quota/ledger.h"  // ledger::reserve(team, window, resource_class, amount, source_version)

constexpr std::chrono::milliseconds kDeadline{250};
constexpr int kMaxAttempts = 2;
const std::set<grpc::StatusCode> kRetriable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto capacity = quota::Capacity::NewStub(grpc::CreateChannel("capacity:9000", grpc::InsecureChannelCredentials()));

// The pool has no room for the amount: the handler answers 409 capacity_exhausted.
struct CapacityExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The pool gave no answer to rely on: the handler answers 503 TRY_AGAIN and writes nothing.
struct CapacityUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The pool's confirmation of the amount: the source_version it was checked against.
std::string confirmCapacity(const std::string& team, const std::string& window, const std::string& resource_class, long long amount) {
  quota::ConfirmRequest request;
  request.set_team(team);
  request.set_window(window);
  request.set_resource_class(resource_class);
  request.set_amount(amount);
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    quota::ConfirmReply reply;
    const grpc::Status status = capacity->Confirm(&ctx, request, &reply);
    if (status.ok()) return reply.source_version();
    // The pool's answer, not a fault: asking again changes nothing.
    if (status.error_code() == grpc::StatusCode::RESOURCE_EXHAUSTED) throw CapacityExhausted(status.error_message());
    if (!kRetriable.count(status.error_code()) || attempt == kMaxAttempts) throw CapacityUnavailable("capacity: " + status.error_message());
  }
}

// Confirm the amount with the capacity service, then take it from the team's window; none when the quota is spent.
std::optional<std::string> reserveWithCapacity(const std::string& team, const std::string& window, const std::string& resource_class,
                                               long long amount) {
  // Unsure is a no: only a confirmation reaches the ledger.
  const std::string source_version = confirmCapacity(team, window, resource_class, amount);
  return ledger::reserve(team, window, resource_class, amount, source_version);
}
`,
    },
  },
  harness: {
    python: `import grpc

import capacity_pb2
import capacity_pb2_grpc

W = "2026-11-02T14:00Z"


class Pool(capacity_pb2_grpc.CapacityServicer):
    """The shared pool: free units in every window; a confirmation names generation pool-v42."""

    def __init__(self):
        self.free = 16

    def Confirm(self, request, context):
        if request.amount > self.free:
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, f"{self.free} {request.resource_class} units free in {request.window}")
        return capacity_pb2.ConfirmReply(source_version="pool-v42")


def _client(ctx):
    pool = Pool()
    ctx.grpc.serve(capacity_pb2_grpc.add_CapacityServicer_to_server, pool)
    return ctx.load("client"), pool


def _outcome(m, amount=4):
    """What reserve_with_capacity did: ("ok", id) or ("raised", exception)."""
    try:
        return "ok", m.reserve_with_capacity("research", W, "gpu-a100", amount)
    except Exception as exc:
        return "raised", exc


def _expect_raise(outcome, exc, why):
    kind, value = outcome
    if kind == "ok":
        raise AssertionError(f"{why}: reserve_with_capacity returned {value!r} instead of raising {exc.__name__}")
    if not isinstance(value, exc):
        raise AssertionError(f"{why}: reserve_with_capacity raised {type(value).__name__}: {value}, expected {exc.__name__}")


def _untouched(ctx, why):
    written = sorted(ctx.redis.keys("quota:research*")) + sorted(ctx.redis.keys("reservation:research:*"))
    assert not written, f"{why}: the ledger was written ({written}). Only a confirmation may reach ledger.reserve"


def _confirms(ctx):
    return len(ctx.grpc.calls_to("Confirm"))


def check_deadline(ctx):
    m, _ = _client(ctx)
    kind, value = _outcome(m)
    assert kind == "ok" and value, f"with the pool answering, a reserve of 4 units must be granted, got {kind} {value!r}"
    calls = ctx.grpc.calls_to("Confirm")
    assert calls, "no Confirm call was made"
    for call in calls:
        assert call.timeout is not None, "a Confirm call carries no deadline: a stalled capacity service holds every reserve open"
        assert 0.2 <= call.timeout <= 0.3, f"a Confirm call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.25"


def check_retry_transient(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Confirm", grpc.StatusCode.UNAVAILABLE, "pool restarting", times=1)
    kind, value = _outcome(m)
    assert kind == "ok" and value, f"one UNAVAILABLE, then an answer: the second attempt must confirm and the reserve be granted, got {kind} {value!r}"
    assert _confirms(ctx) == 2, f"one UNAVAILABLE took {_confirms(ctx)} Confirm calls, expected 2"
    ctx.grpc.fail("Confirm", grpc.StatusCode.UNAVAILABLE, "pool down", times=20)
    before = _confirms(ctx)
    outcome = _outcome(m)
    made = _confirms(ctx) - before
    assert made == 2, f"with the pool down the reserve made {made} Confirm calls, expected MAX_ATTEMPTS = 2"
    _expect_raise(outcome, m.CapacityUnavailable, "with the pool down")


def check_exhausted_terminal(ctx):
    m, pool = _client(ctx)
    pool.free = 2
    outcome = _outcome(m, amount=4)
    assert _confirms(ctx) == 1, f"a pool that answered RESOURCE_EXHAUSTED was asked {_confirms(ctx)} times: a full pool is an answer, not a fault"
    _expect_raise(outcome, m.CapacityExhausted, "with 2 units free in the pool and 4 asked")
    _untouched(ctx, "the pool said it is full")


def check_deny_when_unsure(ctx):
    m, _ = _client(ctx)
    ctx.grpc.set_latency("Confirm", 5.0)
    before = ctx.clock.time()
    outcome = _outcome(m)
    waited = ctx.clock.time() - before
    assert waited <= 1.0, f"the reserve waited {waited:.1f} s for a capacity service that takes 5 s: two attempts of 250 ms, then deny"
    _expect_raise(outcome, m.CapacityUnavailable, "with the capacity service taking 5 s to answer")
    _untouched(ctx, "the capacity service never answered in time")


def check_source_version(ctx):
    m, _ = _client(ctx)
    kind, reservation_id = _outcome(m)
    assert kind == "ok" and reservation_id, f"with the pool answering, a reserve of 4 units must be granted, got {kind} {reservation_id!r}"
    record = ctx.redis.hgetall(f"reservation:research:{reservation_id}")
    assert record.get("source_version") == "pool-v42", f"the reservation records source_version {record.get('source_version')!r}, expected pool-v42 from the ConfirmReply: a grant must be traceable to the pool generation that approved it"
`,
    typescript: `const W = '2026-11-02T14:00Z';

/** The shared pool: free units in every window; a confirmation names generation pool-v42. */
function client(ctx) {
  const pkg = ctx.proto('capacity.proto');
  const pool = {free: 16};
  ctx.grpc.serve(pkg.quota.Capacity.service, {
    Confirm(call, callback) {
      const {amount, resource_class, window} = call.request;
      if (Number(amount) > pool.free) {
        return callback({code: ctx.grpc.status.RESOURCE_EXHAUSTED, details: \`\${pool.free} \${resource_class} units free in \${window}\`});
      }
      callback(null, {source_version: 'pool-v42'});
    },
  });
  return {m: ctx.load('client'), pool};
}

/** What reserveWithCapacity did. */
async function outcome(m, amount = 4): Promise<{ok: boolean; value: unknown}> {
  try {
    return {ok: true, value: await m.reserveWithCapacity('research', W, 'gpu-a100', amount)};
  } catch (e) {
    return {ok: false, value: e};
  }
}

function expectThrow(got: {ok: boolean; value: unknown}, exc, why: string): void {
  if (got.ok) assert.fail(\`\${why}: reserveWithCapacity returned \${JSON.stringify(got.value)} instead of throwing \${exc.name}\`);
  const e = got.value as Error;
  assert(e instanceof exc, \`\${why}: reserveWithCapacity threw \${e.constructor.name}: \${e.message}, expected \${exc.name}\`);
}

function untouched(ctx, why: string): void {
  const written = [...ctx.redis.keys('quota:research*'), ...ctx.redis.keys('reservation:research:*')];
  assert.equal(written.length, 0, \`\${why}: the ledger was written (\${JSON.stringify(written)}). Only a confirmation may reach reserve\`);
}

const confirms = (ctx): number => ctx.grpc.callsTo('Confirm').length;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const got = await outcome(m);
  assert(got.ok && got.value, \`with the pool answering, a reserve of 4 units must be granted, got \${String(got.value)}\`);
  const calls = ctx.grpc.callsTo('Confirm');
  assert(calls.length > 0, 'no Confirm call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Confirm call carries no deadline: a stalled capacity service holds every reserve open');
    assert(call.timeout >= 0.2 && call.timeout <= 0.3, \`a Confirm call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 250\`);
  }
}

export async function check_retry_transient(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Confirm', ctx.grpc.status.UNAVAILABLE, 'pool restarting', 1);
  const first = await outcome(m);
  assert(first.ok && first.value, \`one UNAVAILABLE, then an answer: the second attempt must confirm and the reserve be granted, got \${String(first.value)}\`);
  assert.equal(confirms(ctx), 2, \`one UNAVAILABLE took \${confirms(ctx)} Confirm calls, expected 2\`);
  ctx.grpc.fail('Confirm', ctx.grpc.status.UNAVAILABLE, 'pool down', 20);
  const before = confirms(ctx);
  const down = await outcome(m);
  const made = confirms(ctx) - before;
  assert.equal(made, 2, \`with the pool down the reserve made \${made} Confirm calls, expected MAX_ATTEMPTS = 2\`);
  expectThrow(down, m.CapacityUnavailable, 'with the pool down');
}

export async function check_exhausted_terminal(ctx) {
  const {m, pool} = client(ctx);
  pool.free = 2;
  const got = await outcome(m, 4);
  assert.equal(confirms(ctx), 1, \`a pool that answered RESOURCE_EXHAUSTED was asked \${confirms(ctx)} times: a full pool is an answer, not a fault\`);
  expectThrow(got, m.CapacityExhausted, 'with 2 units free in the pool and 4 asked');
  untouched(ctx, 'the pool said it is full');
}

export async function check_deny_when_unsure(ctx) {
  const {m} = client(ctx);
  ctx.grpc.setLatency('Confirm', 5.0);
  const before = ctx.clock.now();
  const got = await outcome(m);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 1.0, \`the reserve waited \${waited.toFixed(1)} s for a capacity service that takes 5 s: two attempts of 250 ms, then deny\`);
  expectThrow(got, m.CapacityUnavailable, 'with the capacity service taking 5 s to answer');
  untouched(ctx, 'the capacity service never answered in time');
}

export async function check_source_version(ctx) {
  const {m} = client(ctx);
  const got = await outcome(m);
  assert(got.ok && got.value, \`with the pool answering, a reserve of 4 units must be granted, got \${String(got.value)}\`);
  const record = ctx.redis.hgetall(\`reservation:research:\${got.value}\`);
  assert.equal(record.source_version, 'pool-v42', \`the reservation records source_version \${JSON.stringify(record.source_version)}, expected pool-v42 from the ConfirmReply: a grant must be traceable to the pool generation that approved it\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "quota/gen/capacity"

	"leetbuild/harness"
)

const clientWindow = "2026-11-02T14:00Z"

// poolPeer is the shared pool: free units in every window; a confirmation names generation pool-v42.
type poolPeer struct {
	pb.UnimplementedCapacityServer
	free int64
}

func (p *poolPeer) Confirm(_ context.Context, req *pb.ConfirmRequest) (*pb.ConfirmReply, error) {
	if req.GetAmount() > p.free {
		return nil, status.Errorf(codes.ResourceExhausted, "%d %s units free in %s", p.free, req.GetResourceClass(), req.GetWindow())
	}
	return &pb.ConfirmReply{SourceVersion: "pool-v42"}, nil
}

func client(ctx *harness.Ctx) *poolPeer {
	pool := &poolPeer{free: 16}
	pb.RegisterCapacityServer(ctx.GRPC.Server(""), pool)
	return pool
}

func attempt(amount int64) (string, error) {
	return reserveWithCapacity(context.Background(), "research", clientWindow, "gpu-a100", amount)
}

func expectErr(ctx *harness.Ctx, id string, err, target error, why string) {
	ctx.Assert(err != nil, "%s: reserveWithCapacity returned %q instead of an error wrapping %v", why, id, target)
	ctx.ErrorIs(err, target, "%s: reserveWithCapacity returned %v", why, err)
}

func untouched(ctx *harness.Ctx, why string) {
	written := append(ctx.Redis.Keys("quota:research*"), ctx.Redis.Keys("reservation:research:*")...)
	ctx.Assert(len(written) == 0, "%s: the ledger was written (%q). Only a confirmation may reach ledger.Reserve", why, written)
}

func confirms(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Confirm", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	id, err := attempt(4)
	ctx.Assert(err == nil && id != "", "with the pool answering, a reserve of 4 units must be granted, got %q %v", id, err)
	calls := ctx.GRPC.CallsTo("Confirm", "")
	ctx.Assert(len(calls) > 0, "no Confirm call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Confirm call carries no deadline: a stalled capacity service holds every reserve open")
		ctx.Assert(200*time.Millisecond <= call.Timeout && call.Timeout <= 300*time.Millisecond, "a Confirm call carries a %v deadline, expected 250 ms", call.Timeout)
	}
}

func CheckRetryTransient(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Confirm", codes.Unavailable, "pool restarting", 1, "")
	id, err := attempt(4)
	ctx.Assert(err == nil && id != "", "one UNAVAILABLE, then an answer: the second attempt must confirm and the reserve be granted, got %q %v", id, err)
	ctx.Equal(confirms(ctx), 2, "one UNAVAILABLE must cost exactly one more attempt; the Confirm calls")
	ctx.GRPC.Fail("Confirm", codes.Unavailable, "pool down", 20, "")
	before := confirms(ctx)
	id, err = attempt(4)
	ctx.Equal(confirms(ctx)-before, 2, "with the pool down the reserve must stop at maxAttempts; the Confirm calls")
	expectErr(ctx, id, err, ErrCapacityUnavailable, "with the pool down")
}

func CheckExhaustedTerminal(ctx *harness.Ctx) {
	pool := client(ctx)
	pool.free = 2
	id, err := attempt(4)
	ctx.Equal(confirms(ctx), 1, "a pool that answered RESOURCE_EXHAUSTED is an answer, not a fault; the Confirm calls")
	expectErr(ctx, id, err, ErrCapacityExhausted, "with 2 units free in the pool and 4 asked")
	untouched(ctx, "the pool said it is full")
}

func CheckDenyWhenUnsure(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.SetLatency("Confirm", 5.0, "")
	before := ctx.Clock.Now()
	id, err := attempt(4)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 1.0, "the reserve waited %.1f s for a capacity service that takes 5 s: two attempts of 250 ms, then deny", waited)
	expectErr(ctx, id, err, ErrCapacityUnavailable, "with the capacity service taking 5 s to answer")
	untouched(ctx, "the capacity service never answered in time")
}

func CheckSourceVersion(ctx *harness.Ctx) {
	client(ctx)
	id, err := attempt(4)
	ctx.Assert(err == nil && id != "", "with the pool answering, a reserve of 4 units must be granted, got %q %v", id, err)
	record := ctx.Redis.HGetAll("reservation:research:" + id)
	ctx.Equal(record["source_version"], "pool-v42", "the reservation's source_version (a grant must be traceable to the pool generation that approved it, %s)", fmt.Sprint(record))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kW = "2026-11-02T14:00Z";

// The shared pool: free units in every window; a confirmation names generation pool-v42.
class PoolPeer final : public quota::Capacity::Service {
 public:
  long long free = 16;
  grpc::Status Confirm(grpc::ServerContext*, const quota::ConfirmRequest* req, quota::ConfirmReply* out) override {
    if (req->amount() > free) {
      return grpc::Status(grpc::StatusCode::RESOURCE_EXHAUSTED, std::to_string(free) + " " + req->resource_class() + " units free in " + req->window());
    }
    out->set_source_version("pool-v42");
    return grpc::Status::OK;
  }
};

PoolPeer& client(harness::Ctx& ctx) {
  static PoolPeer* pool = nullptr;
  delete pool;
  pool = new PoolPeer;
  ctx.GRPC.Server("")->RegisterService(pool);
  return *pool;
}

// What reserveWithCapacity did: the id it returned, or the exception it threw.
struct Outcome {
  std::optional<std::string> id;
  bool threw = false;
  bool exhausted = false;
  bool unavailable = false;
  std::string what;
};

Outcome attempt(long long amount = 4) {
  Outcome out;
  try {
    out.id = reserveWithCapacity("research", kW, "gpu-a100", amount);
  } catch (const CapacityExhausted& e) {
    out.threw = out.exhausted = true;
    out.what = e.what();
  } catch (const CapacityUnavailable& e) {
    out.threw = out.unavailable = true;
    out.what = e.what();
  } catch (const std::exception& e) {
    out.threw = true;
    out.what = std::string(harness::CurrentExceptionType()) + ": " + e.what();
  }
  return out;
}

void expectThrow(harness::Ctx& ctx, const Outcome& got, bool matched, const std::string& expected, const std::string& why) {
  ctx.Assert(got.threw, "%s: reserveWithCapacity returned %q instead of throwing %s", why, got.id.value_or("nothing"), expected);
  ctx.Assert(matched, "%s: reserveWithCapacity threw %s, expected %s", why, got.what, expected);
}

void untouched(harness::Ctx& ctx, const std::string& why) {
  auto written = ctx.Redis.Keys("quota:research*");
  for (const auto& k : ctx.Redis.Keys("reservation:research:*")) written.push_back(k);
  ctx.Assert(written.empty(), "%s: the ledger was written (%q). Only a confirmation may reach ledger::reserve", why, written);
}

size_t confirms(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Confirm").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const Outcome got = attempt();
  ctx.Assert(!got.threw && got.id, "with the pool answering, a reserve of 4 units must be granted, got %s", got.threw ? got.what : "nothing");
  const auto calls = ctx.GRPC.CallsTo("Confirm");
  ctx.Assert(!calls.empty(), "no Confirm call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Confirm call carries no deadline: a stalled capacity service holds every reserve open");
    ctx.Assert(0.2 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.3, "a Confirm call carries a %v s deadline, expected kDeadline = 250 ms", call.TimeoutSeconds());
  }
}

void CheckRetryTransient(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Confirm", grpc::StatusCode::UNAVAILABLE, "pool restarting", 1);
  const Outcome first = attempt();
  ctx.Assert(!first.threw && first.id, "one UNAVAILABLE, then an answer: the second attempt must confirm and the reserve be granted, got %s", first.threw ? first.what : "nothing");
  ctx.Equal(confirms(ctx), 2, "one UNAVAILABLE must cost exactly one more attempt; the Confirm calls");
  ctx.GRPC.Fail("Confirm", grpc::StatusCode::UNAVAILABLE, "pool down", 20);
  const size_t before = confirms(ctx);
  const Outcome down = attempt();
  ctx.Equal(confirms(ctx) - before, 2, "with the pool down the reserve must stop at kMaxAttempts; the Confirm calls");
  expectThrow(ctx, down, down.unavailable, "CapacityUnavailable", "with the pool down");
}

void CheckExhaustedTerminal(harness::Ctx& ctx) {
  PoolPeer& pool = client(ctx);
  pool.free = 2;
  const Outcome got = attempt(4);
  ctx.Equal(confirms(ctx), 1, "a pool that answered RESOURCE_EXHAUSTED is an answer, not a fault; the Confirm calls");
  expectThrow(ctx, got, got.exhausted, "CapacityExhausted", "with 2 units free in the pool and 4 asked");
  untouched(ctx, "the pool said it is full");
}

void CheckDenyWhenUnsure(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.SetLatency("Confirm", 5.0);
  const int64_t before = ctx.Clock.Now();
  const Outcome got = attempt();
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 1.0, "the reserve waited %.1f s for a capacity service that takes 5 s: two attempts of 250 ms, then deny", waited);
  expectThrow(ctx, got, got.unavailable, "CapacityUnavailable", "with the capacity service taking 5 s to answer");
  untouched(ctx, "the capacity service never answered in time");
}

void CheckSourceVersion(harness::Ctx& ctx) {
  client(ctx);
  const Outcome got = attempt();
  ctx.Assert(!got.threw && got.id, "with the pool answering, a reserve of 4 units must be granted, got %s", got.threw ? got.what : "nothing");
  auto record = ctx.Redis.HGetAll("reservation:research:" + *got.id);
  ctx.Equal(record["source_version"], "pool-v42", "the reservation's source_version (a grant must be traceable to the pool generation that approved it)");
}
`,
  },
  hints: [
    'Stall the capacity service and a reserve hangs as long as it does, then grants. Answer `RESOURCE_EXHAUSTED` and the broker asks five times, sleeps between, and grants anyway.',
    'The loop catches every error alike and has no exit that refuses: it breaks on success or runs out, and either way falls through to `ledger.reserve`. No call carries a deadline and the reply is never read.',
    'Split out `confirm_capacity`: `timeout=DEADLINE_S`, `RESOURCE_EXHAUSTED` raises `CapacityExhausted`, a code in `RETRIABLE` gets one more try, anything else `CapacityUnavailable`; return the reply’s `source_version` and pass it to `ledger.reserve`.',
  ],
  debrief: `The broker only grants what the pool confirmed, so every way of not hearing back has to end in a refusal: a deadline turns a stalled service into an answer, two attempts bound how long a reserve can take, and \`CapacityUnavailable\` keeps an unknown out of the ledger. \`RESOURCE_EXHAUSTED\` is the pool's verdict, which is why it is never retried. Recording \`source_version\` lets an operator match a grant to the pool generation that approved it after a rebalance. Production brokers add jitter to the retry, share one deadline budget across attempts, and stop calling a pool whose error rate crosses a threshold instead of paying two timeouts per reserve.`,
};
