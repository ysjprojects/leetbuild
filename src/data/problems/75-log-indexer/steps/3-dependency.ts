import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Index shard calls with retryable and terminal errors',
  concept: 'grpc',
  file: 'client',
  focus: ['writer', 'shard'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds a \`BulkWrite\`
request, calls the shard, and loops until it succeeds. It compiles, it writes documents on the happy
path, and it hides three production flaws — one of them duplicates documents whenever a shard
blinks. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`bulk_write\` for one committed batch of records:

- Every attempt carries a **3-second deadline**; a call that never answers must not hold the batch
  forever.
- Attempts are **bounded** (\`MAX_ATTEMPTS = 3\`) and only the retryable statuses are retried:
  \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. Retry with a small backoff between attempts. A shard that
  times out once must be tried again, not abandoned.
- A mapping conflict (\`INVALID_ARGUMENT\` or \`FAILED_PRECONDITION\` from the shard) is **terminal
  for the batch**: raise/return a \`MappingConflict\` that carries the offending **field** the shard
  named, so the caller can fix the mapping instead of replaying a batch that will never be accepted.
- The batch id is minted **once per batch, before the retry loop**, and every attempt sends that same
  id. The shard dedupes on it, so a replayed attempt is a no-op. The draft mints a new id inside the
  loop, so a retry writes a second copy of every document.
- The request also carries the **attempt number**, so the shard and the logs can tell a first try
  from a replay.

**Failure mode the checks target.** The draft's three flaws compound: it retries a mapping conflict
forever, so one bad field pins a worker in a hot loop against a shard that will never accept the
batch; it treats a single \`DEADLINE_EXCEEDED\` as fatal, so a shard that is merely slow loses the
batch; and it mints the batch id per attempt, so the retry it does perform duplicates the records the
first attempt may have written.`,
  sequence: {
    participants: ['Buffered writer', 'Index shard'],
    messages: [
      {
        from: 'Buffered writer',
        to: 'Index shard',
        label: 'BulkWrite{batch_id, attempt: 1} · 3 s deadline',
        kind: 'sync',
      },
      {from: 'Index shard', to: 'Buffered writer', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Buffered writer', to: 'Buffered writer', label: 'retryable → backoff, same batch_id', kind: 'sync'},
      {from: 'Buffered writer', to: 'Index shard', label: 'BulkWrite{batch_id, attempt: 2}', kind: 'sync'},
      {from: 'Index shard', to: 'Buffered writer', label: 'FAILED_PRECONDITION · field=user_id', kind: 'reply'},
      {from: 'Buffered writer', to: 'Buffered writer', label: 'terminal → MappingConflict(field)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 3-second deadline',
      detail:
        'Each attempt sets a 3-second deadline (`DEADLINE_S` / `DEADLINE_MS = 3000` / `set_deadline` / `withDeadlineAfter`). An attempt without a deadline can hold the writer until the shard decides to answer.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000/, /deadline:\s*DEADLINE_MS/]},
        go: {all: [/deadlineS\s*=\s*3/, /WithTimeout\(ctx,\s*deadlineS\*time\.Second\)/]},
        scala: {all: [/DeadlineS\s*=\s*3/, /withDeadlineAfter\(DeadlineS,\s*TimeUnit\.SECONDS\)/]},
        cpp: {all: [/kDeadlineS\s*=\s*3/, /set_deadline\(/]},
      },
    },
    {
      id: 'retryable-set',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED, with a bound',
      detail:
        'The retryable set is exactly `UNAVAILABLE` and `DEADLINE_EXCEEDED`, the attempts are capped at `MAX_ATTEMPTS`, and a backoff separates them. The draft gives up on the first timeout and retries everything else forever.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS/, /BACKOFF_S/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS/, /BACKOFF_MS/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /maxAttempts/, /backoffMS/]},
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MaxAttempts/, /BackoffMs/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kMaxAttempts/, /kBackoffMs/]},
      },
    },
    {
      id: 'terminal-conflict',
      title: 'Surfaces a mapping conflict as terminal, with the field',
      detail:
        '`INVALID_ARGUMENT` / `FAILED_PRECONDITION` raise a `MappingConflict` carrying the offending `field` from the shard — never a retry. The draft retries the conflict forever, so one bad mapping pins the worker.',
      match: {
        python: {all: [/(?:INVALID_ARGUMENT|FAILED_PRECONDITION)/, /MappingConflict/, /field/]},
        typescript: {all: [/(?:INVALID_ARGUMENT|FAILED_PRECONDITION)/, /MappingConflict/, /field/]},
        go: {all: [/(?:InvalidArgument|FailedPrecondition)/, /MappingConflict/, /Field/]},
        scala: {all: [/(?:INVALID_ARGUMENT|FAILED_PRECONDITION)/, /MappingConflict/, /field/]},
        cpp: {all: [/(?:INVALID_ARGUMENT|FAILED_PRECONDITION)/, /MappingConflict/, /field/]},
      },
    },
    {
      id: 'stable-batch-id',
      title: 'Mints the batch id once, before the retry loop',
      detail:
        'The batch id is created before the loop and reused by every attempt, so a replay carries the same id. The draft mints a new id inside the loop, which turns a retry into a second copy of the batch.',
      match: {
        python: {all: [/batch_id/], order: [/batch_id\s*=\s*str\(uuid\.uuid4\(\)\)/, /\bwhile\b/]},
        typescript: {all: [/batchId/], order: [/const batchId = randomUUID\(\)/, /\bfor\b/]},
        go: {all: [/batchID/], order: [/batchID := uuid\.NewString\(\)/, /\bfor\b/]},
        scala: {all: [/batchId/], order: [/val batchId = UUID\.randomUUID\(\)\.toString/, /\bwhile\b/]},
        cpp: {all: [/batchId/], order: [/const std::string batchId = uuidString\(\)/, /\bfor\b/]},
      },
    },
    {
      id: 'request-dedupe',
      title: 'Sends the batch id and the attempt in the request',
      detail:
        "The request carries `batch_id` and the `attempt` number, which is the shard's dedupe key — a replayed batch is recognised instead of duplicated. The draft sends a fresh id each time, so the shard cannot tell a replay from a new batch.",
      match: {
        python: {all: [/BulkWriteRequest\(/, /batch_id=batch_id/, /attempt=attempt/]},
        typescript: {all: [/BulkWrite/, /batch_id:\s*batchId/, /attempt/]},
        go: {all: [/BulkWriteRequest\{/, /BatchId:\s*batchID/, /Attempt:/]},
        scala: {all: [/BulkWriteRequest\(/, /batchId = batchId/, /attempt = attempt/]},
        cpp: {all: [/BulkWriteRequest/, /set_batch_id\(batchId\)/, /set_attempt\(attempt\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Index shard client."""
import uuid

import grpc

import index_pb2


def bulk_write(stub, index: str, records: list[bytes]) -> str:
    # TODO: this draft retries a mapping conflict forever, abandons the batch on the first shard
    # timeout, and mints a new batch id per attempt so a retry duplicates every document. Review
    # all three.
    attempt = 0
    while True:
        attempt += 1
        batch_id = str(uuid.uuid4())
        request = index_pb2.BulkWriteRequest(
            index=index,
            batch_id=batch_id,
            attempt=attempt,
            records=records,
        )
        try:
            stub.BulkWrite(request, timeout=8.0)
            return batch_id
        except grpc.RpcError:
            continue
`,
      solution: `"""Index shard client: a deadline, a bounded retry set, and one batch id across attempts."""
import time
import uuid

import grpc

import index_pb2

DEADLINE_S = 3
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
TERMINAL = (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION)


class MappingConflict(Exception):
    """The shard rejected the batch: a field in the mapping does not match the index."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


class ShardUnavailable(Exception):
    """Every attempt failed with a retryable status."""


def conflict_field(exc: grpc.RpcError) -> str:
    for key, value in exc.trailing_metadata() or ():
        if key == "conflict-field":
            return value
    return ""


def bulk_write(stub, index: str, records: list[bytes]) -> str:
    # One batch id for the whole call: every attempt sends the same id, so the shard's dedupe
    # turns a replayed attempt into a no-op instead of a second copy of every document.
    batch_id = str(uuid.uuid4())
    attempt = 0
    last: grpc.RpcError | None = None
    while attempt < MAX_ATTEMPTS:
        attempt += 1
        request = index_pb2.BulkWriteRequest(
            index=index,
            batch_id=batch_id,
            attempt=attempt,
            records=records,
        )
        try:
            stub.BulkWrite(request, timeout=DEADLINE_S)
            return batch_id
        except grpc.RpcError as exc:
            code = exc.code()
            if code in TERMINAL:
                # Terminal for the batch: a retry would be rejected exactly the same way.
                raise MappingConflict(conflict_field(exc), exc.details()) from exc
            if code not in RETRYABLE:
                raise
            last = exc
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
    raise ShardUnavailable(f"shard unavailable after {MAX_ATTEMPTS} attempts: {last}")
`,
    },
    typescript: {
      starter: `/** Index shard client: a model-generated draft that re-mints the batch id per attempt. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

export interface BulkWriteRequest {
  index: string;
  batch_id: string;
  attempt: number;
  records: Uint8Array[];
}

export interface ShardClient {
  bulkWrite(request: BulkWriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<unknown>;
}

export async function bulkWrite(
  client: ShardClient,
  index: string,
  records: Uint8Array[],
): Promise<string> {
  // TODO: this draft retries a mapping conflict forever, abandons the batch on the first shard
  // timeout, and mints a new batch id per attempt so a retry duplicates every document. Review
  // all three.
  for (;;) {
    const batchId = randomUUID();
    const request: BulkWriteRequest = {index, batch_id: batchId, attempt: 1, records};
    try {
      await client.bulkWrite(request, new grpc.Metadata(), {});
      return batchId;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** Index shard client: a deadline, a bounded retry set, and one batch id across attempts. */
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 3000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 200;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
const TERMINAL = new Set([grpc.status.INVALID_ARGUMENT, grpc.status.FAILED_PRECONDITION]);

export interface BulkWriteRequest {
  index: string;
  batch_id: string;
  attempt: number;
  records: Uint8Array[];
}

export interface ShardClient {
  bulkWrite(request: BulkWriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<unknown>;
}

export class MappingConflict extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export class ShardUnavailable extends Error {}

export async function bulkWrite(
  client: ShardClient,
  index: string,
  records: Uint8Array[],
): Promise<string> {
  // One batch id for the whole call: every attempt sends the same id, so the shard's dedupe
  // turns a replayed attempt into a no-op instead of a second copy of every document.
  const batchId = randomUUID();
  let last: unknown = undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request: BulkWriteRequest = {index, batch_id: batchId, attempt, records};
    try {
      await client.bulkWrite(request, new grpc.Metadata(), {deadline: DEADLINE_MS});
      return batchId;
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (TERMINAL.has(code)) {
        // Terminal for the batch: a retry would be rejected exactly the same way.
        throw new MappingConflict(conflictField(error as grpc.ServiceError), (error as Error).message);
      }
      if (!RETRYABLE.has(code)) throw error;
      last = error;
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
    }
  }
  throw new ShardUnavailable(\`shard unavailable after \${MAX_ATTEMPTS} attempts: \${String(last)}\`);
}

function conflictField(error: grpc.ServiceError): string {
  const value = error.metadata?.get('conflict-field');
  return value !== undefined && value.length > 0 ? String(value[0]) : '';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"

	pb "index/shardpb"
)

// BulkWrite ships one batch of records to an index shard.
func BulkWrite(ctx context.Context, client pb.ShardClient, index string, records [][]byte) (string, error) {
	// TODO: this draft retries a mapping conflict forever, abandons the batch on the first shard
	// timeout, and mints a new batch id per attempt so a retry duplicates every document. Review
	// all three.
	for {
		batchID := uuid.NewString()
		request := &pb.BulkWriteRequest{
			Index:   index,
			BatchId: batchID,
			Attempt: 1,
			Records: records,
		}
		if _, err := client.BulkWrite(ctx, request); err == nil {
			return batchID, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "index/shardpb"
)

const (
	deadlineS   = 3
	maxAttempts = 3
	backoffMS   = 200
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var terminal = map[codes.Code]bool{codes.InvalidArgument: true, codes.FailedPrecondition: true}

// MappingConflict is terminal for the batch: a retry would be rejected exactly the same way.
type MappingConflict struct {
	Field   string
	Message string
}

func (e *MappingConflict) Error() string { return e.Message }

func conflictField(err error) string {
	if st, ok := status.FromError(err); ok {
		if values := st.TrailingMetadata().Get("conflict-field"); len(values) > 0 {
			return string(values[0])
		}
	}
	return ""
}

func BulkWrite(ctx context.Context, client pb.ShardClient, index string, records [][]byte) (string, error) {
	// One batch id for the whole call: every attempt sends the same id, so the shard's dedupe
	// turns a replayed attempt into a no-op instead of a second copy of every document.
	batchID := uuid.NewString()
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
		request := &pb.BulkWriteRequest{
			Index:   index,
			BatchId: batchID,
			Attempt: int32(attempt),
			Records: records,
		}
		_, err := client.BulkWrite(callCtx, request)
		cancel()
		if err == nil {
			return batchID, nil
		}
		code := status.Code(err)
		if terminal[code] {
			return "", &MappingConflict{Field: conflictField(err), Message: err.Error()}
		}
		if !retryable[code] {
			return "", err
		}
		lastErr = err
		if attempt < maxAttempts {
			time.Sleep(time.Duration(backoffMS*attempt) * time.Millisecond)
		}
	}
	return "", fmt.Errorf("shard unavailable after %d attempts: %w", maxAttempts, lastErr)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object Client {
  val stub = ShardGrpc.blockingStub(ManagedChannelBuilder.forAddress("shard", 9000).usePlaintext().build())

  // TODO: this draft retries a mapping conflict forever, abandons the batch on the first shard
  // timeout, and mints a new batch id per attempt so a retry duplicates every document. Review
  // all three.
  def bulkWrite(index: String, records: Seq[Array[Byte]]): String = {
    var result: String = null
    var attempt = 1
    while (result == null) {
      val batchId = UUID.randomUUID().toString
      val request = BulkWriteRequest(index = index, batchId = batchId, attempt = attempt, records = records)
      try {
        stub.bulkWrite(request)
        result = batchId
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    result
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object Client {
  val DeadlineS = 3L
  val MaxAttempts = 3
  val BackoffMs = 200L
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val Terminal = Set(Status.Code.INVALID_ARGUMENT, Status.Code.FAILED_PRECONDITION)
  val ConflictFieldKey = io.grpc.Metadata.Key.of("conflict-field", io.grpc.Metadata.ASCII_STRING_MARSHALLER)

  val stub = ShardGrpc.blockingStub(ManagedChannelBuilder.forAddress("shard", 9000).usePlaintext().build())

  // Terminal for the batch: a retry would be rejected exactly the same way.
  class MappingConflict(val field: String, message: String) extends RuntimeException(message)

  def conflictField(error: StatusRuntimeException): String = {
    val trailers = error.getTrailers
    if (trailers == null) "" else Option(trailers.get(ConflictFieldKey)).getOrElse("")
  }

  def bulkWrite(index: String, records: Seq[Array[Byte]]): String = {
    // One batch id for the whole call: every attempt sends the same id, so the shard's dedupe
    // turns a replayed attempt into a no-op instead of a second copy of every document.
    val batchId = UUID.randomUUID().toString
    var attempt = 1
    var lastError: StatusRuntimeException = null
    var result: String = null
    while (attempt <= MaxAttempts && result == null) {
      val request = BulkWriteRequest(index = index, batchId = batchId, attempt = attempt, records = records)
      try {
        stub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).bulkWrite(request)
        result = batchId
      } catch {
        case error: StatusRuntimeException =>
          val code = error.getStatus.getCode
          if (Terminal.contains(code)) {
            throw new MappingConflict(conflictField(error), error.getStatus.getDescription)
          }
          if (!Retryable.contains(code)) throw error
          lastError = error
          if (attempt < MaxAttempts) Thread.sleep(BackoffMs * attempt)
      }
      attempt += 1
    }
    if (result == null) {
      throw new RuntimeException(s"shard unavailable after $MaxAttempts attempts: $lastError")
    }
    result
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "index.grpc.pb.h"

#include <memory>
#include <string>
#include <vector>

std::string uuidString();

// BulkWrite ships one batch of records to an index shard.
std::string bulkWrite(
    const std::shared_ptr<Shard::Stub>& stub,
    const std::string& index,
    const std::vector<std::string>& records) {
  // TODO: this draft retries a mapping conflict forever, abandons the batch on the first shard
  // timeout, and mints a new batch id per attempt so a retry duplicates every document. Review
  // all three.
  int attempt = 1;
  while (true) {
    const std::string batchId = uuidString();
    grpc::ClientContext ctx;
    BulkWriteRequest request;
    request.set_index(index);
    request.set_batch_id(batchId);
    request.set_attempt(attempt);
    request.mutable_records()->Assign(records.begin(), records.end());
    BulkWriteReply reply;
    if (stub->BulkWrite(&ctx, request, &reply).ok()) return batchId;
    attempt += 1;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "index.grpc.pb.h"

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

constexpr int kDeadlineS = 3;
constexpr int kMaxAttempts = 3;
constexpr int kBackoffMs = 200;

std::string uuidString();

// Terminal for the batch: a retry would be rejected exactly the same way.
class MappingConflict : public std::runtime_error {
 public:
  MappingConflict(const std::string& offendingField, const std::string& message)
      : std::runtime_error(message), field(offendingField) {}
  std::string field;
};

std::string conflictField(const grpc::Status& status) { return status.error_details(); }

std::string bulkWrite(
    const std::shared_ptr<Shard::Stub>& stub,
    const std::string& index,
    const std::vector<std::string>& records) {
  // One batch id for the whole call: every attempt sends the same id, so the shard's dedupe
  // turns a replayed attempt into a no-op instead of a second copy of every document.
  const std::string batchId = uuidString();
  grpc::Status last;
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
    BulkWriteRequest request;
    request.set_index(index);
    request.set_batch_id(batchId);
    request.set_attempt(attempt);
    request.mutable_records()->Assign(records.begin(), records.end());
    BulkWriteReply reply;
    const grpc::Status status = stub->BulkWrite(&ctx, request, &reply);
    if (status.ok()) return batchId;
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT ||
        status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) {
      throw MappingConflict(conflictField(status), status.error_message());
    }
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE &&
        status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
      throw std::runtime_error(status.error_message());
    }
    last = status;
    if (attempt < kMaxAttempts) {
      std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs * attempt));
    }
  }
  throw std::runtime_error("shard unavailable: " + last.error_message());
}
`,
    },
  },
  hints: [
    'Write the failure policy as three sets before you write the loop: a deadline for one attempt, a bounded attempt count, and the statuses worth another attempt (`UNAVAILABLE`, `DEADLINE_EXCEEDED`). A mapping conflict is a statement about the data, not about the shard, so no amount of retrying changes it.',
    "The batch id is the dedupe key, so it has to exist before the loop. Mint it once, put it in every attempt's request next to the attempt number, and the shard can turn a replay into a no-op instead of a second copy of every document.",
    'A `FAILED_PRECONDITION` from the shard usually names the field it choked on. Carry that field into your `MappingConflict` so the caller sees `user_id` instead of "batch failed", and make the error type distinct enough that the caller will never retry it.',
  ],
  debrief: `The interviewer is testing the failure contract of a networked write, which a generated snippet almost always gets wrong in the same way. The deadline bounds one attempt; the attempt count bounds the whole call; the retryable set decides which failures even deserve another try; and the batch id is the idempotency key that makes retrying safe, which is why it must be minted outside the loop — a retry with a fresh id is a second write, whatever the code comments say. Terminal errors are the other half: a mapping conflict is evidence that the data will be rejected forever, so retrying it is a hot loop against a shard that already answered. Real clients add jittered exponential backoff, a per-shard concurrency limit, a breaker so a dead shard stops receiving traffic, and a dead-letter batch that a human can re-map and replay with the original id.`,
};
