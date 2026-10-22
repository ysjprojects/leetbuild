import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Apply calls idempotent by change id',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'target', 'source'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the target is healthy it
applies every change correctly, so the demo converges. Both failure paths are wrong. Find them, fix
them, and prove the fix.

Implement the target-region client: \`apply_change(stub, change)\` (or the stack's equivalent) plus
the target-side handler that dedupes by change id.

- Every attempt runs under a **3-second deadline** — a call deadline, a context with timeout, a
  \`withDeadlineAfter\`, or a \`set_deadline\` on the client context. Without one, a wedged target
  pins the controller's worker until the process is restarted.
- At most **3 attempts** per change, and only the retryable statuses (\`UNAVAILABLE\`,
  \`DEADLINE_EXCEEDED\`, \`RESOURCE_EXHAUSTED\`) are retried. A permanent rejection is returned to
  the caller immediately, never spun on.
- **Every attempt carries the change id.** A timeout does not mean the target did not apply the
  change: the call may have been applied and the response lost. The retry therefore has to look
  exactly like the original attempt, so the target can recognise the id and drop the duplicate.
  Dropping the id on the retry path is the quiet defect in this draft — the retry lands as a new
  change and inserts a second row.
- A **schema mismatch** (\`FAILED_PRECONDITION\`) is terminal: halt the shard with the target's
  **named diff** instead of retrying. Retrying a schema mismatch is a hot loop against a target that
  will never accept the change, and it hides the real problem — the change's shape does not match
  the target's.
- \`target_apply(request)\` is the target's handler: it **dedupes by change id**, so applying the
  same change twice changes nothing — the second call is a no-op and no second row is inserted.

**Failure mode the checks target.** The draft retries forever with no deadline, builds its retry
request without the change id, and treats a schema mismatch like any other error. The result is the
incident this course reviews: a call that timed out after it was applied is applied again, and
because the id is gone the target has no way to tell that the second call is the same change.`,
  sequence: {
    participants: ['Replication controller', 'Target region', 'Shard halter'],
    messages: [
      {from: 'Replication controller', to: 'Target region', label: 'Apply(change_id) · deadline 3 s', kind: 'sync'},
      {
        from: 'Target region',
        to: 'Replication controller',
        label: 'applied · retryable · mismatch + diff',
        kind: 'reply',
      },
      {
        from: 'Replication controller',
        to: 'Replication controller',
        label: 'retry only retryable · ≤ 3 attempts',
        kind: 'sync',
      },
      {from: 'Replication controller', to: 'Target region', label: 'retry carries the same change_id', kind: 'sync'},
      {from: 'Replication controller', to: 'Shard halter', label: 'halt shard with the named diff', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 3-second deadline',
      detail:
        'The call is bounded by a 3 s deadline — `timeout=APPLY_DEADLINE_S`, `deadline: Date.now() + APPLY_DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, or `set_deadline`. The draft calls the target with no deadline at all.',
      match: {
        python: {all: [/APPLY_DEADLINE_S\s*=\s*3\.0/, /timeout=APPLY_DEADLINE_S/]},
        typescript: {all: [/APPLY_DEADLINE_MS\s*=\s*3000/, /deadline: Date\.now\(\) \+ APPLY_DEADLINE_MS/]},
        go: {all: [/applyDeadline\s*=\s*3 \* time\.Second/, /context\.WithTimeout\(ctx, applyDeadline\)/]},
        scala: {
          all: [
            /ApplyDeadline\s*=\s*java\.time\.Duration\.ofSeconds\(3\)/,
            /withDeadlineAfter\(ApplyDeadline\.toMillis/,
          ],
        },
        cpp: {
          all: [
            /kApplyDeadline\s*=\s*std::chrono::seconds\(3\)/,
            /set_deadline\(std::chrono::system_clock::now\(\) \+ kApplyDeadline\)/,
          ],
        },
      },
    },
    {
      id: 'change-id',
      title: 'Every attempt carries the change id',
      detail:
        'The request is built once, with `change_id`, before the retry loop, so the retry of a call that timed out is recognisable as the same change. The draft drops the id on every retry path, and the target inserts a second row.',
      match: {
        python: {
          all: [/change_id=change\.change_id/],
          order: [/change_id=change\.change_id/, /for attempt in range\(MAX_ATTEMPTS\)/],
        },
        typescript: {
          all: [/change_id: change\.change_id/],
          order: [/change_id: change\.change_id/, /for \(let attempt = 0; attempt < MAX_ATTEMPTS/],
        },
        go: {
          all: [/ChangeId: change\.ChangeID/],
          order: [/ChangeId: change\.ChangeID/, /for attempt := 0; attempt < maxAttempts/],
        },
        scala: {
          all: [/change_id = Some\(change\.change_id\)/],
          order: [/change_id = Some\(change\.change_id\)/, /attempt < MaxAttempts/],
        },
        cpp: {
          all: [/set_change_id\(change\.change_id\(\)\)/],
          order: [/set_change_id\(change\.change_id\(\)\)/, /for \(int attempt = 0; attempt < kMaxAttempts/],
        },
      },
    },
    {
      id: 'schema-mismatch',
      title: 'A schema mismatch halts the shard with a named diff',
      detail:
        '`FAILED_PRECONDITION` is terminal: it raises the schema-mismatch error carrying `named_diff` instead of being retried. The draft retries it like any other failure, forever.',
      match: {
        python: {all: [/SchemaMismatch/, /StatusCode\.FAILED_PRECONDITION/, /named_diff/]},
        typescript: {all: [/SchemaMismatchError/, /grpc\.status\.FAILED_PRECONDITION/, /namedDiff/]},
        go: {all: [/errSchemaMismatch/, /codes\.FailedPrecondition/, /namedDiff/]},
        scala: {all: [/SchemaMismatch/, /Status\.Code\.FAILED_PRECONDITION/, /namedDiff/]},
        cpp: {all: [/SchemaMismatch/, /grpc::StatusCode::FAILED_PRECONDITION/, /namedDiff/]},
      },
    },
    {
      id: 'idempotent-apply',
      title: 'The target dedupes by change id, so a second apply changes nothing',
      detail:
        'The target handler checks the applied set for the change id and returns before inserting anything, so a re-applied change is a no-op. The draft inserts on every call.',
      match: {
        python: {all: [/APPLIED_CHANGES/, /if request\.change_id in APPLIED_CHANGES/]},
        typescript: {all: [/appliedChanges/, /appliedChanges\.has\(request\.change_id\)/]},
        go: {all: [/appliedChanges/, /appliedChanges\[request\.ChangeId\]/]},
        scala: {all: [/AppliedChanges/, /AppliedChanges\.contains\(request\.change_id\)/]},
        cpp: {all: [/appliedChanges/, /appliedChanges\.count\(request\.change_id\(\)\)/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most three attempts, then the error is surfaced',
      detail:
        'The retry loop is bounded by `3` attempts and raises the last retryable failure when they are exhausted. The draft loops forever.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /for attempt in range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt < MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts\s*=\s*3/, /attempt < maxAttempts/]},
        scala: {all: [/MaxAttempts\s*=\s*3/, /attempt < MaxAttempts/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /attempt < kMaxAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import apply_pb2
import apply_pb2_grpc


# TODO: this draft retries every error forever with no deadline, drops the change id on the retry
# path so a call that timed out after it was applied is applied a second time and inserts a
# duplicate row, and retries a schema mismatch instead of halting the shard with the diff.
def apply_change(stub, change) -> None:
    attempt = 0
    while True:
        try:
            if attempt == 0:
                request = apply_pb2.ApplyRequest(
                    change_id=change.change_id, shard=change.shard, payload=change.payload
                )
            else:
                request = apply_pb2.ApplyRequest(shard=change.shard, payload=change.payload)
            stub.Apply(request)
            return
        except grpc.RpcError:
            attempt += 1


def target_apply(request) -> None:
    """The target region's handler: insert the change."""
    insert_row(request)
`,
      solution: `import grpc

import apply_pb2
import apply_pb2_grpc

APPLY_DEADLINE_S = 3.0
MAX_ATTEMPTS = 3
RETRYABLE = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.RESOURCE_EXHAUSTED,
}

# The target dedupes by change id: a repeated id is a no-op, so re-applying a change can never
# insert a second row.
APPLIED_CHANGES: set[str] = set()


class SchemaMismatch(Exception):
    """The target rejected the change because its shape does not match the target's schema."""


def apply_change(stub, change) -> None:
    """Apply one change under a deadline, at most MAX_ATTEMPTS attempts, each carrying the change id."""
    request = apply_pb2.ApplyRequest(
        change_id=change.change_id,
        shard=change.shard,
        payload=change.payload,
    )
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            stub.Apply(request, timeout=APPLY_DEADLINE_S)
            return
        except grpc.RpcError as exc:
            status = exc.code()
            if status == grpc.StatusCode.FAILED_PRECONDITION:
                raise SchemaMismatch(named_diff(exc))
            if status not in RETRYABLE:
                raise
            last_error = exc
    raise last_error


def named_diff(error: grpc.RpcError) -> str:
    """The target's diff between the change's shape and its own schema."""
    raise NotImplementedError


def target_apply(request) -> None:
    """The target region's handler: dedupe by change id, then insert."""
    if request.change_id in APPLIED_CHANGES:
        return
    APPLIED_CHANGES.add(request.change_id)
    insert_row(request)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

interface Change {
  change_id: string;
  shard: number;
  payload: Buffer;
}

interface ApplyRequest {
  change_id?: string;
  shard: number;
  payload: Buffer;
}

// TODO: this draft retries every error forever with no deadline, drops the change id on the retry
// path so a call that timed out after it was applied is applied a second time and inserts a
// duplicate row, and retries a schema mismatch instead of halting the shard with the diff.
export async function applyChange(client: ApplyClient, change: Change): Promise<void> {
  let attempt = 0;
  while (true) {
    const request: ApplyRequest =
      attempt === 0
        ? {change_id: change.change_id, shard: change.shard, payload: change.payload}
        : {shard: change.shard, payload: change.payload};
    try {
      await applyOnce(client, request);
      return;
    } catch {
      attempt += 1;
    }
  }
}

function applyOnce(client: ApplyClient, request: ApplyRequest): Promise<void> {
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  client.Apply(request, new grpc.Metadata(), error => (error ? reject(error) : resolve()));
  return promise;
}

export function targetApply(request: ApplyRequest): void {
  insertRow(request);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

const APPLY_DEADLINE_MS = 3000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.RESOURCE_EXHAUSTED]: true,
};

// The target dedupes by change id: a repeated id is a no-op, so re-applying a change can never
// insert a second row.
const appliedChanges = new Set<string>();

interface Change {
  change_id: string;
  shard: number;
  payload: Buffer;
}

interface ApplyRequest {
  change_id?: string;
  shard: number;
  payload: Buffer;
}

export class SchemaMismatchError extends Error {}

export async function applyChange(client: ApplyClient, change: Change): Promise<void> {
  const request: ApplyRequest = {change_id: change.change_id, shard: change.shard, payload: change.payload};
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await applyOnce(client, request);
      return;
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code === grpc.status.FAILED_PRECONDITION) throw new SchemaMismatchError(namedDiff(serviceError));
      if (RETRYABLE[serviceError.code] !== true) throw serviceError;
      lastError = serviceError;
    }
  }
  throw lastError;
}

function applyOnce(client: ApplyClient, request: ApplyRequest): Promise<void> {
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  client.Apply(
    request,
    new grpc.Metadata(),
    {deadline: Date.now() + APPLY_DEADLINE_MS},
    error => (error ? reject(error) : resolve()),
  );
  return promise;
}

function namedDiff(error: grpc.ServiceError): string {
  return error.details;
}

export function targetApply(request: ApplyRequest): void {
  if (appliedChanges.has(request.change_id)) return;
  appliedChanges.add(request.change_id);
  insertRow(request);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

type Change struct {
	ChangeID string
	Shard    int
	Payload  []byte
}

// TODO: this draft retries every error forever with no deadline, drops the change id on the retry
// path so a call that timed out after it was applied is applied a second time and inserts a
// duplicate row, and retries a schema mismatch instead of halting the shard with the diff.
func applyChange(ctx context.Context, client ApplyServiceClient, change Change) error {
	attempt := 0
	for {
		request := &ApplyRequest{Shard: change.Shard, Payload: change.Payload}
		if attempt == 0 {
			request.ChangeId = change.ChangeID
		}
		if _, err := client.Apply(ctx, request); err == nil {
			return nil
		}
		attempt++
	}
}

func targetApply(ctx context.Context, request *ApplyRequest) error {
	return insertRow(ctx, request)
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
	"google.golang.org/grpc/status"
)

const (
	applyDeadline = 3 * time.Second
	maxAttempts   = 3
)

type Change struct {
	ChangeID string
	Shard    int
	Payload  []byte
}

var retryable = map[codes.Code]bool{
	codes.Unavailable:       true,
	codes.DeadlineExceeded:  true,
	codes.ResourceExhausted: true,
}

var errSchemaMismatch = errors.New("schema mismatch")

// appliedChanges is the target's dedupe set: a repeated change id is a no-op, so re-applying a
// change can never insert a second row.
var appliedChanges = map[string]bool{}

func applyChange(ctx context.Context, client ApplyServiceClient, change Change) error {
	request := &ApplyRequest{ChangeId: change.ChangeID, Shard: change.Shard, Payload: change.Payload}
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, applyDeadline)
		_, err := client.Apply(attemptCtx, request)
		cancel()
		if err == nil {
			return nil
		}
		if status.Code(err) == codes.FailedPrecondition {
			return fmt.Errorf("%w: %s", errSchemaMismatch, namedDiff(err))
		}
		if !retryable[status.Code(err)] {
			return err
		}
		lastErr = err
	}
	return lastErr
}

func namedDiff(err error) string {
	return status.Convert(err).Message()
}

func targetApply(ctx context.Context, request *ApplyRequest) error {
	if appliedChanges[request.ChangeId] {
		return nil
	}
	appliedChanges[request.ChangeId] = true
	return insertRow(ctx, request)
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

final case class Change(change_id: String, shard: Int, payload: Array[Byte])
final case class ApplyRequest(change_id: Option[String], shard: Int, payload: Array[Byte])

object ApplyClient {
  // TODO: this draft retries every error forever with no deadline, drops the change id on the retry
  // path so a call that timed out after it was applied is applied a second time and inserts a
  // duplicate row, and retries a schema mismatch instead of halting the shard with the diff.
  def applyChange(stub: ApplyServiceGrpc.ApplyServiceBlockingStub, change: Change): Unit = {
    var attempt = 0
    while (true) {
      val request =
        if (attempt == 0) ApplyRequest(Some(change.change_id), change.shard, change.payload)
        else ApplyRequest(None, change.shard, change.payload)
      try {
        stub.apply(request)
        return
      } catch {
        case _: StatusRuntimeException => attempt += 1
      }
    }
  }

  def targetApply(request: ApplyRequest): Unit = insertRow(request)
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

import scala.collection.mutable

final case class Change(change_id: String, shard: Int, payload: Array[Byte])
final case class ApplyRequest(change_id: Option[String], shard: Int, payload: Array[Byte])

object ApplyClient {
  val ApplyDeadline = java.time.Duration.ofSeconds(3)
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED, Status.Code.RESOURCE_EXHAUSTED)

  // The target dedupes by change id: a repeated id is a no-op, so re-applying a change can never
  // insert a second row.
  val AppliedChanges: mutable.Set[String] = mutable.Set.empty[String]

  final case class SchemaMismatch(diff: String) extends RuntimeException(s"schema mismatch: $diff")

  def applyChange(stub: ApplyServiceGrpc.ApplyServiceBlockingStub, change: Change): Unit = {
    val request = ApplyRequest(change_id = Some(change.change_id), shard = change.shard, payload = change.payload)
    var lastError: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        stub.withDeadlineAfter(ApplyDeadline.toMillis, TimeUnit.MILLISECONDS).apply(request)
        return
      } catch {
        case error: StatusRuntimeException =>
          val code = error.getStatus.getCode
          if (code == Status.Code.FAILED_PRECONDITION) throw SchemaMismatch(namedDiff(error))
          if (!Retryable.contains(code)) throw error
          lastError = Some(error)
          attempt += 1
      }
    }
    throw lastError.getOrElse(new IllegalStateException("no attempt was made"))
  }

  def namedDiff(error: StatusRuntimeException): String = error.getStatus.getDescription

  def targetApply(request: ApplyRequest): Unit = {
    if (AppliedChanges.contains(request.change_id)) return
    AppliedChanges.add(request.change_id.get)
    insertRow(request)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "apply.grpc.pb.h"

#include <string>

// TODO: this draft retries every error forever with no deadline, drops the change id on the retry
// path so a call that timed out after it was applied is applied a second time and inserts a
// duplicate row, and retries a schema mismatch instead of halting the shard with the diff.
void applyChange(apply::ApplyService::Stub& stub, const Change& change) {
  int attempt = 0;
  while (true) {
    apply::ApplyRequest request;
    if (attempt == 0) request.set_change_id(change.change_id());
    request.set_shard(change.shard());
    request.set_payload(change.payload());
    grpc::ClientContext context;
    apply::ApplyResponse response;
    if (stub.Apply(&context, request, &response).ok()) return;
    ++attempt;
  }
}

void targetApply(const apply::ApplyRequest& request) {
  insertRow(request);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "apply.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace {

constexpr int kMaxAttempts = 3;
const auto kApplyDeadline = std::chrono::seconds(3);

class SchemaMismatch : public std::runtime_error {
 public:
  explicit SchemaMismatch(const std::string& diff) : std::runtime_error("schema mismatch: " + diff) {}
};

class RpcFailure : public std::runtime_error {
 public:
  explicit RpcFailure(const grpc::Status& status) : std::runtime_error(status.error_message()) {}
};

// appliedChanges is the target's dedupe set: a repeated change id is a no-op, so re-applying a
// change can never insert a second row.
std::unordered_set<std::string> appliedChanges;

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED ||
         code == grpc::StatusCode::RESOURCE_EXHAUSTED;
}

std::string namedDiff(const grpc::Status& status) { return status.error_message(); }

}  // namespace

void applyChange(apply::ApplyService::Stub& stub, const Change& change) {
  apply::ApplyRequest request;
  request.set_change_id(change.change_id());
  request.set_shard(change.shard());
  request.set_payload(change.payload());
  grpc::Status lastStatus;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + kApplyDeadline);
    apply::ApplyResponse response;
    const auto status = stub.Apply(&context, request, &response);
    if (status.ok()) return;
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) throw SchemaMismatch(namedDiff(status));
    if (!retryable(status.error_code())) throw RpcFailure(status);
    lastStatus = status;
  }
  throw RpcFailure(lastStatus);
}

void targetApply(const apply::ApplyRequest& request) {
  if (appliedChanges.count(request.change_id()) > 0) return;
  appliedChanges.insert(request.change_id());
  insertRow(request);
}
`,
    },
  },
  hints: [
    'Build the request once, before the loop: `change_id` belongs to the change, not to the attempt. Every retry sends the identical message, which is what lets the target answer a duplicate with a no-op instead of a second insert.',
    'Bound the loop with a constant and check the status code, not the fact that an error was thrown: retry `UNAVAILABLE` / `DEADLINE_EXCEEDED` / `RESOURCE_EXHAUSTED`, return anything else immediately, and raise the last retryable error when the attempts run out.',
    'Treat `FAILED_PRECONDITION` as terminal and carry the target’s description with it as the named diff: a schema mismatch is not a transient failure, and retrying it turns one bad change into an infinite loop while hiding the diff that would have explained it in seconds.',
  ],
  debrief: `The interviewer is testing whether you can review generated retry logic for the difference between "the call failed" and "the change did not happen". A timeout is not a negative acknowledgement: the target may have applied the change and lost the response, so the retry has to be recognisable — same change id, so the target dedupes — or the replica silently grows duplicate rows. The second half is the failure classification: a schema mismatch is terminal, and retrying it is both useless and expensive. Real replicators add a per-shard fencing token so two controllers cannot apply the same shard concurrently, apply in the target's transaction with the dedupe row inside it, and record the diff on the shard's state so an operator sees which change halted it.`,
};
