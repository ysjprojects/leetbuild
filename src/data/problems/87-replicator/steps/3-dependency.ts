import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'ApplyChange over gRPC: a deadline, three attempts, one change id',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'target', 'redis'],
  task: `## Task

**Starting point.** The starter is \`replicate_change(replication_id, shard, change)\`: it advances the
shard's offset with \`advance_offset\` (\`replication.offsets\`), then sends \`ApplyChange\` to the target
region with a fresh request id per attempt, sleeping and retrying any error up to eight times; it
returns the shard's offset or raises \`ApplyFailed\`. With a healthy target the demo converges, and it
hides five flaws.

**Failure mode the checks target.** A wedged target holds the worker forever; a lost reply makes the
retry apply the same change twice; a schema the target lacks is retried eight times; and a change
the target never applied is marked done, so a restart skips it.

\`\`\`proto
service TargetRegion { rpc ApplyChange(ApplyChangeRequest) returns (ApplyChangeReply); }
// dedupes by change_id · FAILED_PRECONDITION: schema mismatch, the named diff in the details
\`\`\`

- Every attempt carries a **3 s** deadline (\`DEADLINE_S\`).
- At most \`MAX_ATTEMPTS\` = **3** attempts, retrying only \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` and
  \`RESOURCE_EXHAUSTED\`; any other code, or the last attempt, raises \`ApplyFailed\`.
- Every attempt sends the change's own \`change_id\`: build the request once, before the loop.
- \`FAILED_PRECONDITION\` raises \`SchemaMismatch\` with the target's diff, without a retry.
- \`advance_offset\` runs only after the target confirmed.`,
  sequence: {
    participants: ['Replication worker', 'Target region', 'Redis'],
    messages: [
      {
        from: 'Replication worker',
        to: 'Target region',
        label: 'ApplyChange(change_id=c-7) · deadline 3 s',
        kind: 'sync',
      },
      {
        from: 'Target region',
        to: 'Replication worker',
        label: 'UNAVAILABLE (reply lost after the write)',
        kind: 'reply',
      },
      {from: 'Replication worker', to: 'Target region', label: 'retry · same change_id=c-7', kind: 'sync'},
      {from: 'Target region', to: 'Replication worker', label: 'duplicate=true · nothing written twice', kind: 'reply'},
      {
        from: 'Replication worker',
        to: 'Redis',
        label: 'advance_offset(rep, shard, 7) after the confirmation',
        kind: 'sync',
      },
      {
        from: 'Target region',
        to: 'Replication worker',
        label: 'FAILED_PRECONDITION + diff → SchemaMismatch, shard halts',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 3-second deadline',
      detail:
        'Each `ApplyChange` call is made with `DEADLINE_S` (3 s): `timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. Without one, a target that stops answering holds the worker.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3\b/, /ApplyChange\([^\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/applyDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*applyDeadline\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*3L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kApplyDeadline\{3\}/, /set_deadline\([^\n]*kApplyDeadline\)/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most three attempts, and only on retryable codes',
      detail:
        'The loop runs `MAX_ATTEMPTS` (3) times and retries only `UNAVAILABLE`, `DEADLINE_EXCEEDED` and `RESOURCE_EXHAUSTED`; any other code, or the third failure, raises `ApplyFailed`.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /range\(MAX_ATTEMPTS\)/, /RESOURCE_EXHAUSTED/], none: [/range\(8\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /<\s*MAX_ATTEMPTS/, /RESOURCE_EXHAUSTED/], none: [/<\s*8\b/]},
        go: {all: [/maxAttempts\s*=\s*3\b/, /<\s*maxAttempts/, /codes\.ResourceExhausted/], none: [/<\s*8\b/]},
        scala: {all: [/MaxAttempts\s*=\s*3\b/, /MaxAttempts/, /RESOURCE_EXHAUSTED/], none: [/<\s*8\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /<\s*kMaxAttempts/, /RESOURCE_EXHAUSTED/], none: [/<\s*8\b/]},
      },
    },
    {
      id: 'change-id',
      title: 'Every attempt carries the change id',
      detail:
        "The request is built once, before the retry loop, with the change's own `change_id`, so the target recognises a retry of a call whose reply was lost; a fresh id per attempt makes every retry a new change.",
      match: {
        python: {
          all: [/change_id\s*=\s*change\[["']change_id["']\]/],
          order: [/change_id\s*=\s*change\[/, /for attempt in/],
          none: [/uuid/],
        },
        typescript: {
          all: [/change_id:\s*change\.change_id/],
          order: [/change_id:\s*change\.change_id/, /for \(let attempt/],
          none: [/randomUUID/],
        },
        go: {
          all: [/ChangeId:\s*change\.ChangeID/],
          order: [/ChangeId:\s*change\.ChangeID/, /for attempt :=/],
          none: [/uuid\./],
        },
        scala: {
          all: [/changeId\s*=\s*change\.changeId/],
          order: [/changeId\s*=\s*change\.changeId/, /while \(/],
          none: [/UUID/],
        },
        cpp: {
          all: [/set_change_id\(change\.change_id\)/],
          order: [/set_change_id\(change\.change_id\)/, /for \(int attempt/],
          none: [/uuid_/],
        },
      },
    },
    {
      id: 'schema-mismatch',
      title: 'A schema mismatch halts the shard with the diff',
      detail:
        '`FAILED_PRECONDITION` raises `SchemaMismatch` carrying the details (the named diff) at once, without a retry or a sleep: the target will refuse the change until someone migrates its schema.',
      match: {
        python: {all: [/StatusCode\.FAILED_PRECONDITION/, /raise SchemaMismatch\(/]},
        typescript: {all: [/status\.FAILED_PRECONDITION/, /throw new SchemaMismatch\(/]},
        go: {all: [/codes\.FailedPrecondition/, /ErrSchemaMismatch/]},
        scala: {all: [/Status\.Code\.FAILED_PRECONDITION/, /throw new SchemaMismatch\(/]},
        cpp: {all: [/StatusCode::FAILED_PRECONDITION/, /throw SchemaMismatch\(/]},
      },
    },
    {
      id: 'advance-after-confirm',
      title: 'The offset advances only after the target confirmed',
      detail:
        '`advance_offset`/`advanceOffset` is called after the `ApplyChange` loop succeeded, never before it: an offset that names a change the target does not hold makes a restart skip that change.',
      match: {
        python: {order: [/\.ApplyChange\(/, /advance_offset\(/]},
        typescript: {order: [/\.ApplyChange\(/, /advanceOffset\(/]},
        go: {order: [/\.ApplyChange\(/, /offsets\.AdvanceOffset\(/]},
        scala: {order: [/\.applyChange\(/, /Offsets\.advanceOffset\(/]},
        cpp: {order: [/->ApplyChange\(/, /offsets::advanceOffset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

import grpc

import replicator_pb2
import replicator_pb2_grpc
from replication.offsets import advance_offset

target = replicator_pb2_grpc.TargetRegionStub(grpc.insecure_channel("target-region:9000"))


class SchemaMismatch(Exception):
    """The target's schema lacks the change's shape: the shard halts until the schema is migrated."""


class ApplyFailed(Exception):
    """The target did not confirm the change: the shard retries it later from its confirmed offset."""


def replicate_change(replication_id: str, shard: int, change: dict) -> int:
    """Apply one change (change_id, offset, key, value) at the target; returns the shard's offset afterwards."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    confirmed = advance_offset(replication_id, shard, change["offset"])
    for attempt in range(8):
        request = replicator_pb2.ApplyChangeRequest(
            replication_id=replication_id,
            shard=shard,
            change_id=str(uuid.uuid4()),
            offset=change["offset"],
            key=change["key"],
            value=change["value"],
        )
        try:
            target.ApplyChange(request)
            return confirmed
        except grpc.RpcError:
            time.sleep(0.5 * 2**attempt)
    raise ApplyFailed(f"change {change['change_id']} not applied after 8 attempts")
`,
      solution: `import time

import grpc

import replicator_pb2
import replicator_pb2_grpc
from replication.offsets import advance_offset

DEADLINE_S = 3
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.RESOURCE_EXHAUSTED)

target = replicator_pb2_grpc.TargetRegionStub(grpc.insecure_channel("target-region:9000"))


class SchemaMismatch(Exception):
    """The target's schema lacks the change's shape: the shard halts until the schema is migrated."""


class ApplyFailed(Exception):
    """The target did not confirm the change: the shard retries it later from its confirmed offset."""


def replicate_change(replication_id: str, shard: int, change: dict) -> int:
    """Apply one change (change_id, offset, key, value) at the target; returns the shard's offset afterwards."""
    # One request for every attempt: the target dedupes a retry of a call whose reply was lost by its change_id.
    request = replicator_pb2.ApplyChangeRequest(
        replication_id=replication_id,
        shard=shard,
        change_id=change["change_id"],
        offset=change["offset"],
        key=change["key"],
        value=change["value"],
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            target.ApplyChange(request, timeout=DEADLINE_S)
            break
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
                raise SchemaMismatch(exc.details()) from exc  # retrying cannot change the target's schema
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS - 1:
                raise ApplyFailed(f"change {change['change_id']}: {exc.code().name}") from exc
            time.sleep(0.2 * 2**attempt)
    # Confirmed: only now does the shard's offset move past the change.
    return advance_offset(replication_id, shard, change["offset"])
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {advanceOffset} from 'replication/offsets';

export interface Change {
  change_id: string;
  offset: number;
  key: string;
  value: string;
}

interface ApplyChangeRequest extends Change {
  replication_id: string;
  shard: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('replicator.proto')) as unknown as {
  replicatord: {TargetRegion: grpc.ServiceClientConstructor};
};
const target = new pkg.replicatord.TargetRegion('target-region:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ApplyChange(request: ApplyChangeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{duplicate: boolean}>;
};

/** The target's schema lacks the change's shape: the shard halts until the schema is migrated. */
export class SchemaMismatch extends Error {}
/** The target did not confirm the change: the shard retries it later from its confirmed offset. */
export class ApplyFailed extends Error {}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Apply one change at the target; resolves the shard's offset afterwards. */
export async function replicateChange(replicationId: string, shard: number, change: Change): Promise<number> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const confirmed = await advanceOffset(replicationId, shard, change.offset);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const request = {replication_id: replicationId, shard, change_id: randomUUID(), offset: change.offset, key: change.key, value: change.value};
    try {
      await target.ApplyChange(request, new grpc.Metadata(), {});
      return confirmed;
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new ApplyFailed(\`change \${change.change_id} not applied after 8 attempts\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {advanceOffset} from 'replication/offsets';

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.RESOURCE_EXHAUSTED];

export interface Change {
  change_id: string;
  offset: number;
  key: string;
  value: string;
}

interface ApplyChangeRequest extends Change {
  replication_id: string;
  shard: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('replicator.proto')) as unknown as {
  replicatord: {TargetRegion: grpc.ServiceClientConstructor};
};
const target = new pkg.replicatord.TargetRegion('target-region:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ApplyChange(request: ApplyChangeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{duplicate: boolean}>;
};

/** The target's schema lacks the change's shape: the shard halts until the schema is migrated. */
export class SchemaMismatch extends Error {}
/** The target did not confirm the change: the shard retries it later from its confirmed offset. */
export class ApplyFailed extends Error {}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Apply one change at the target; resolves the shard's offset afterwards. */
export async function replicateChange(replicationId: string, shard: number, change: Change): Promise<number> {
  // One request for every attempt: the target dedupes a retry of a call whose reply was lost by its change_id.
  const request = {replication_id: replicationId, shard, change_id: change.change_id, offset: change.offset, key: change.key, value: change.value};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await target.ApplyChange(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      break;
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      // Retrying cannot change the target's schema.
      if (code === grpc.status.FAILED_PRECONDITION) throw new SchemaMismatch(details);
      if (!RETRYABLE.includes(code) || attempt === MAX_ATTEMPTS - 1) throw new ApplyFailed(\`change \${change.change_id}: \${grpc.status[code]}\`);
      await sleep(200 * 2 ** attempt);
    }
  }
  // Confirmed: only now does the shard's offset move past the change.
  return advanceOffset(replicationId, shard, change.offset);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "replication/gen/replicator"
	"replication/offsets" // offsets.AdvanceOffset(ctx, replicationID, shard, offset) (int64, error)
)

// Change is one change of a shard as the source's change log holds it.
type Change struct {
	ChangeID string
	Offset   int64
	Key      string
	Value    string
}

var (
	targetConn, _ = grpc.NewClient("target-region:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	target        = pb.NewTargetRegionClient(targetConn)
)

var (
	// ErrSchemaMismatch: the target's schema lacks the change's shape, the shard halts until the schema is migrated.
	ErrSchemaMismatch = errors.New("schema mismatch")
	// ErrApplyFailed: the target did not confirm the change, the shard retries it later from its confirmed offset.
	ErrApplyFailed = errors.New("apply failed")
)

// replicateChange applies one change at the target and returns the shard's offset afterwards.
func replicateChange(ctx context.Context, replicationID string, shard int, change Change) (int64, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	confirmed, err := offsets.AdvanceOffset(ctx, replicationID, shard, change.Offset)
	if err != nil {
		return 0, err
	}
	for attempt := 0; attempt < 8; attempt++ {
		request := &pb.ApplyChangeRequest{
			ReplicationId: replicationID, Shard: int32(shard), ChangeId: uuid.NewString(),
			Offset: change.Offset, Key: change.Key, Value: change.Value,
		}
		if _, err := target.ApplyChange(ctx, request); err == nil {
			return confirmed, nil
		}
		time.Sleep(time.Duration(500<<attempt) * time.Millisecond)
	}
	return 0, fmt.Errorf("%w: change %s not applied after 8 attempts", ErrApplyFailed, change.ChangeID)
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

	pb "replication/gen/replicator"
	"replication/offsets" // offsets.AdvanceOffset(ctx, replicationID, shard, offset) (int64, error)
)

const (
	applyDeadline = 3 * time.Second
	maxAttempts   = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true, codes.ResourceExhausted: true}

// Change is one change of a shard as the source's change log holds it.
type Change struct {
	ChangeID string
	Offset   int64
	Key      string
	Value    string
}

var (
	targetConn, _ = grpc.NewClient("target-region:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	target        = pb.NewTargetRegionClient(targetConn)
)

var (
	// ErrSchemaMismatch: the target's schema lacks the change's shape, the shard halts until the schema is migrated.
	ErrSchemaMismatch = errors.New("schema mismatch")
	// ErrApplyFailed: the target did not confirm the change, the shard retries it later from its confirmed offset.
	ErrApplyFailed = errors.New("apply failed")
)

// replicateChange applies one change at the target and returns the shard's offset afterwards.
func replicateChange(ctx context.Context, replicationID string, shard int, change Change) (int64, error) {
	// One request for every attempt: the target dedupes a retry of a call whose reply was lost by its change_id.
	request := &pb.ApplyChangeRequest{
		ReplicationId: replicationID, Shard: int32(shard), ChangeId: change.ChangeID,
		Offset: change.Offset, Key: change.Key, Value: change.Value,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, applyDeadline)
		_, err := target.ApplyChange(callCtx, request)
		cancel()
		if err == nil {
			break
		}
		code := status.Code(err)
		if code == codes.FailedPrecondition {
			// Retrying cannot change the target's schema.
			return 0, fmt.Errorf("%w: %s", ErrSchemaMismatch, status.Convert(err).Message())
		}
		if !retryable[code] || attempt == maxAttempts-1 {
			return 0, fmt.Errorf("%w: change %s: %v", ErrApplyFailed, change.ChangeID, code)
		}
		time.Sleep(time.Duration(200<<attempt) * time.Millisecond)
	}
	// Confirmed: only now does the shard's offset move past the change.
	return offsets.AdvanceOffset(ctx, replicationID, shard, change.Offset)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import replication.Offsets // Offsets.advanceOffset(replicationId, shard, offset): Long
import replicatord.replicator.{ApplyChangeRequest, TargetRegionGrpc}

/** One change of a shard as the source's change log holds it. */
final case class Change(changeId: String, offset: Long, key: String, value: String)

/** The target's schema lacks the change's shape: the shard halts until the schema is migrated. */
final class SchemaMismatch(message: String) extends Exception(message)
/** The target did not confirm the change: the shard retries it later from its confirmed offset. */
final class ApplyFailed(message: String) extends Exception(message)

object Client {
  private val target = TargetRegionGrpc.blockingStub(ManagedChannelBuilder.forAddress("target-region", 9000).usePlaintext().build())

  /** Apply one change at the target; returns the shard's offset afterwards. */
  def replicateChange(replicationId: String, shard: Int, change: Change): Long = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val confirmed = Offsets.advanceOffset(replicationId, shard, change.offset)
    var attempt = 0
    while (attempt < 8) {
      val request = ApplyChangeRequest(replicationId, shard, UUID.randomUUID().toString, change.offset, change.key, change.value)
      try {
        target.applyChange(request)
        return confirmed
      } catch {
        case _: StatusRuntimeException =>
          Thread.sleep(500L << attempt)
          attempt += 1
      }
    }
    throw new ApplyFailed(s"change \${change.changeId} not applied after 8 attempts")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import replication.Offsets // Offsets.advanceOffset(replicationId, shard, offset): Long
import replicatord.replicator.{ApplyChangeRequest, TargetRegionGrpc}

/** One change of a shard as the source's change log holds it. */
final case class Change(changeId: String, offset: Long, key: String, value: String)

/** The target's schema lacks the change's shape: the shard halts until the schema is migrated. */
final class SchemaMismatch(message: String) extends Exception(message)
/** The target did not confirm the change: the shard retries it later from its confirmed offset. */
final class ApplyFailed(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 3L
  val MaxAttempts = 3
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED, Status.Code.RESOURCE_EXHAUSTED)

  private val target = TargetRegionGrpc.blockingStub(ManagedChannelBuilder.forAddress("target-region", 9000).usePlaintext().build())

  /** Apply one change at the target; returns the shard's offset afterwards. */
  def replicateChange(replicationId: String, shard: Int, change: Change): Long = {
    // One request for every attempt: the target dedupes a retry of a call whose reply was lost by its change_id.
    val request = ApplyChangeRequest(replicationId, shard, changeId = change.changeId, offset = change.offset, key = change.key, value = change.value)
    var attempt = 0
    var confirmed = false
    while (!confirmed) {
      try {
        target.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).applyChange(request)
        confirmed = true
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          // Retrying cannot change the target's schema.
          if (code == Status.Code.FAILED_PRECONDITION) throw new SchemaMismatch(Option(e.getStatus.getDescription).getOrElse("schema mismatch"))
          if (!Retryable.contains(code) || attempt == MaxAttempts - 1) throw new ApplyFailed(s"change \${change.changeId}: $code")
          Thread.sleep(200L << attempt)
          attempt += 1
      }
    }
    // Confirmed: only now does the shard's offset move past the change.
    Offsets.advanceOffset(replicationId, shard, change.offset)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <uuid/uuid.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "replication/offsets.h"  // offsets::advanceOffset(replication_id, shard, offset) -> long long
#include "replicator.grpc.pb.h"

// One change of a shard as the source's change log holds it.
struct Change {
  std::string change_id;
  long long offset;
  std::string key;
  std::string value;
};

// The target's schema lacks the change's shape: the shard halts until the schema is migrated.
struct SchemaMismatch : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The target did not confirm the change: the shard retries it later from its confirmed offset.
struct ApplyFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto target = replicatord::TargetRegion::NewStub(grpc::CreateChannel("target-region:9000", grpc::InsecureChannelCredentials()));

std::string requestId() {
  uuid_t id;
  uuid_generate(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

// Apply one change at the target; returns the shard's offset afterwards.
long long replicateChange(const std::string& replication_id, int shard, const Change& change) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const long long confirmed = offsets::advanceOffset(replication_id, shard, change.offset);
  for (int attempt = 0; attempt < 8; attempt++) {
    replicatord::ApplyChangeRequest request;
    request.set_replication_id(replication_id);
    request.set_shard(shard);
    request.set_change_id(requestId());
    request.set_offset(change.offset);
    request.set_key(change.key);
    request.set_value(change.value);
    grpc::ClientContext ctx;
    replicatord::ApplyChangeReply reply;
    if (target->ApplyChange(&ctx, request, &reply).ok()) return confirmed;
    std::this_thread::sleep_for(std::chrono::milliseconds(500 << attempt));
  }
  throw ApplyFailed("change " + change.change_id + " not applied after 8 attempts");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>

#include "replication/offsets.h"  // offsets::advanceOffset(replication_id, shard, offset) -> long long
#include "replicator.grpc.pb.h"

constexpr std::chrono::seconds kApplyDeadline{3};
constexpr int kMaxAttempts = 3;
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED,
                                               grpc::StatusCode::RESOURCE_EXHAUSTED};

// One change of a shard as the source's change log holds it.
struct Change {
  std::string change_id;
  long long offset;
  std::string key;
  std::string value;
};

// The target's schema lacks the change's shape: the shard halts until the schema is migrated.
struct SchemaMismatch : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The target did not confirm the change: the shard retries it later from its confirmed offset.
struct ApplyFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto target = replicatord::TargetRegion::NewStub(grpc::CreateChannel("target-region:9000", grpc::InsecureChannelCredentials()));

// Apply one change at the target; returns the shard's offset afterwards.
long long replicateChange(const std::string& replication_id, int shard, const Change& change) {
  // One request for every attempt: the target dedupes a retry of a call whose reply was lost by its change_id.
  replicatord::ApplyChangeRequest request;
  request.set_replication_id(replication_id);
  request.set_shard(shard);
  request.set_change_id(change.change_id);
  request.set_offset(change.offset);
  request.set_key(change.key);
  request.set_value(change.value);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kApplyDeadline);
    replicatord::ApplyChangeReply reply;
    const grpc::Status status = target->ApplyChange(&ctx, request, &reply);
    if (status.ok()) break;
    // Retrying cannot change the target's schema.
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) throw SchemaMismatch(status.error_message());
    if (!kRetryable.count(status.error_code()) || attempt == kMaxAttempts - 1) {
      throw ApplyFailed("change " + change.change_id + ": " + status.error_message());
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200 << attempt));
  }
  // Confirmed: only now does the shard's offset move past the change.
  return offsets::advanceOffset(replication_id, shard, change.offset);
}
`,
    },
  },
  harness: {
    python: `import grpc

import replicator_pb2
import replicator_pb2_grpc
from replication.offsets import resume_offset

DIFF = "orders.discount_code: text at the source, missing at the target"


def _change(n, key=None):
    return {"change_id": f"c-{n}", "offset": n, "key": key or f"orders/{n}", "value": f'{{"total": {n}00}}'}


class Target(replicator_pb2_grpc.TargetRegionServicer):
    """The target region: dedupes by change_id; lose_replies drops the reply of that many applied calls."""

    def __init__(self):
        self.applied = []
        self.lose_replies = 0
        self.mismatched = set()

    def ApplyChange(self, request, context):
        if request.key in self.mismatched:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, DIFF)
        if request.change_id in self.applied:
            return replicator_pb2.ApplyChangeReply(duplicate=True)
        self.applied.append(request.change_id)
        if self.lose_replies > 0:
            self.lose_replies -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset after the write committed")
        return replicator_pb2.ApplyChangeReply(duplicate=False)


def _client(ctx):
    target = Target()
    ctx.grpc.serve(replicator_pb2_grpc.add_TargetRegionServicer_to_server, target)
    return ctx.load("client"), target


def _raises(m, exc, change, why):
    try:
        offset = m.replicate_change("rep-1", 0, change)
    except exc as e:
        return e
    except Exception as other:
        raise AssertionError(f"{why}: replicate_change raised {type(other).__name__}: {other}, expected {exc.__name__}")
    raise AssertionError(f"{why}: replicate_change returned {offset!r} instead of raising {exc.__name__}")


def check_deadline(ctx):
    m, _ = _client(ctx)
    assert m.replicate_change("rep-1", 0, _change(1)) == 1, "with a healthy target replicate_change must return the shard's offset 1"
    for call in ctx.grpc.calls_to("ApplyChange"):
        assert call.timeout is not None, "an ApplyChange call carries no deadline: a target that stops answering holds the worker"
        assert 2.5 <= call.timeout <= 3.5, f"an ApplyChange call carries a {call.timeout} s deadline, expected DEADLINE_S = 3"
    ctx.grpc.set_latency("ApplyChange", 10.0)
    before = len(ctx.grpc.calls_to("ApplyChange"))
    _raises(m, m.ApplyFailed, _change(2), "with a target slower than the deadline")
    made = len(ctx.grpc.calls_to("ApplyChange")) - before
    assert made <= 3, f"a target slower than the deadline was called {made} times, expected at most 3"


def check_bounded_attempts(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("ApplyChange", grpc.StatusCode.INVALID_ARGUMENT, "offset is not an integer", times=1)
    _raises(m, m.ApplyFailed, _change(1), "with a request the target rejects (INVALID_ARGUMENT)")
    calls = len(ctx.grpc.calls_to("ApplyChange"))
    assert calls == 1, f"INVALID_ARGUMENT was retried: {calls} calls, expected 1 (only UNAVAILABLE, DEADLINE_EXCEEDED and RESOURCE_EXHAUSTED are retried)"
    ctx.grpc.fail("ApplyChange", grpc.StatusCode.UNAVAILABLE, times=10)
    _raises(m, m.ApplyFailed, _change(2), "with the target unavailable")
    calls = len(ctx.grpc.calls_to("ApplyChange")) - 1
    assert calls == 3, f"an unavailable target was called {calls} times for one change, expected MAX_ATTEMPTS = 3"


def check_change_id(ctx):
    m, target = _client(ctx)
    target.lose_replies = 1
    offset = m.replicate_change("rep-1", 0, _change(7))
    sent = [c.request.change_id for c in ctx.grpc.calls_to("ApplyChange")]
    assert len(target.applied) == 1, f"the reply of the first attempt was lost and the target applied the change {len(target.applied)} times (change ids {sent}): every attempt must carry the change's own change_id"
    assert sent and all(s == "c-7" for s in sent), f"the attempts carried change ids {sent}, expected c-7 on each"
    assert offset == 7, f"replicate_change returned {offset}, expected the shard's offset 7"


def check_schema_mismatch(ctx):
    m, target = _client(ctx)
    target.mismatched.add("orders/3")
    error = _raises(m, m.SchemaMismatch, _change(3), "with a change the target's schema lacks")
    assert "discount_code" in str(error), f"SchemaMismatch must carry the target's diff, got {error}"
    calls = len(ctx.grpc.calls_to("ApplyChange"))
    assert calls == 1, f"a schema mismatch was sent {calls} times: the target refuses it until its schema changes"
    assert ctx.clock.sleeps == 0, "a schema mismatch must not be slept on and retried"
    assert resume_offset("rep-1", 0) == 0, f"the shard's offset moved to {resume_offset('rep-1', 0)} past a change the target refused"


def check_advance_after_confirm(ctx):
    m, _ = _client(ctx)
    m.replicate_change("rep-1", 0, _change(1))
    ctx.grpc.fail("ApplyChange", grpc.StatusCode.UNAVAILABLE, times=20)
    try:
        m.replicate_change("rep-1", 0, _change(2))
    except Exception:
        pass
    else:
        raise AssertionError("replicate_change returned although the target never confirmed change c-2")
    resumed = resume_offset("rep-1", 0)
    assert resumed == 1, f"the target never confirmed c-2 and the shard's offset is {resumed}, expected 1: a restart would skip c-2"
`,
    typescript: `const DIFF = 'orders.discount_code: text at the source, missing at the target';

const change = (n: number, key?: string) => ({change_id: \`c-\${n}\`, offset: n, key: key ?? \`orders/\${n}\`, value: \`{"total": \${n}00}\`});

/** The target region: dedupes by change_id; loseReplies drops the reply of that many applied calls. */
function client(ctx) {
  const pkg = ctx.proto('replicator.proto');
  const target = {applied: [] as string[], loseReplies: 0, mismatched: new Set<string>()};
  ctx.grpc.serve(pkg.replicatord.TargetRegion.service, {
    ApplyChange(call, callback) {
      const {key, change_id} = call.request;
      if (target.mismatched.has(key)) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: DIFF});
      if (target.applied.includes(change_id)) return callback(null, {duplicate: true});
      target.applied.push(change_id);
      if (target.loseReplies > 0) {
        target.loseReplies -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset after the write committed'});
      }
      callback(null, {duplicate: false});
    },
  });
  return {m: ctx.load('client'), target, offsets: ctx.load('/support/replication/offsets.ts')};
}

async function raises(m, exc, c, why: string) {
  let offset;
  try {
    offset = await m.replicateChange('rep-1', 0, c);
  } catch (e) {
    if (e instanceof exc) return e as Error;
    assert.fail(\`\${why}: replicateChange threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected \${exc.name}\`);
  }
  assert.fail(\`\${why}: replicateChange returned \${offset} instead of throwing \${exc.name}\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal(await m.replicateChange('rep-1', 0, change(1)), 1, 'with a healthy target replicateChange must resolve the shard offset 1');
  for (const call of ctx.grpc.callsTo('ApplyChange')) {
    assert(call.timeout !== null, 'an ApplyChange call carries no deadline: a target that stops answering holds the worker');
    assert(2.5 <= call.timeout && call.timeout <= 3.5, \`an ApplyChange call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 3000\`);
  }
  ctx.grpc.setLatency('ApplyChange', 10.0);
  const before = ctx.grpc.callsTo('ApplyChange').length;
  await raises(m, m.ApplyFailed, change(2), 'with a target slower than the deadline');
  const made = ctx.grpc.callsTo('ApplyChange').length - before;
  assert(made <= 3, \`a target slower than the deadline was called \${made} times, expected at most 3\`);
}

export async function check_bounded_attempts(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('ApplyChange', ctx.grpc.status.INVALID_ARGUMENT, 'offset is not an integer', 1);
  await raises(m, m.ApplyFailed, change(1), 'with a request the target rejects (INVALID_ARGUMENT)');
  let calls = ctx.grpc.callsTo('ApplyChange').length;
  assert.equal(calls, 1, \`INVALID_ARGUMENT was retried: \${calls} calls, expected 1 (only UNAVAILABLE, DEADLINE_EXCEEDED and RESOURCE_EXHAUSTED are retried)\`);
  ctx.grpc.fail('ApplyChange', ctx.grpc.status.UNAVAILABLE, '', 10);
  await raises(m, m.ApplyFailed, change(2), 'with the target unavailable');
  calls = ctx.grpc.callsTo('ApplyChange').length - 1;
  assert.equal(calls, 3, \`an unavailable target was called \${calls} times for one change, expected MAX_ATTEMPTS = 3\`);
}

export async function check_change_id(ctx) {
  const {m, target} = client(ctx);
  target.loseReplies = 1;
  const offset = await m.replicateChange('rep-1', 0, change(7));
  const sent = ctx.grpc.callsTo('ApplyChange').map(c => c.request.change_id);
  assert.equal(target.applied.length, 1, \`the reply of the first attempt was lost and the target applied the change \${target.applied.length} times (change ids \${JSON.stringify(sent)}): every attempt must carry the change's own change_id\`);
  assert(sent.length > 0 && sent.every(s => s === 'c-7'), \`the attempts carried change ids \${JSON.stringify(sent)}, expected c-7 on each\`);
  assert.equal(offset, 7, \`replicateChange resolved \${offset}, expected the shard offset 7\`);
}

export async function check_schema_mismatch(ctx) {
  const {m, target, offsets} = client(ctx);
  target.mismatched.add('orders/3');
  const error = await raises(m, m.SchemaMismatch, change(3), "with a change the target's schema lacks");
  assert(error.message.includes('discount_code'), \`SchemaMismatch must carry the target's diff, got \${error.message}\`);
  const calls = ctx.grpc.callsTo('ApplyChange').length;
  assert.equal(calls, 1, \`a schema mismatch was sent \${calls} times: the target refuses it until its schema changes\`);
  assert.equal(ctx.clock.sleeps, 0, 'a schema mismatch must not be slept on and retried');
  const resumed = await offsets.resumeOffset('rep-1', 0);
  assert.equal(resumed, 0, \`the shard offset moved to \${resumed} past a change the target refused\`);
}

export async function check_advance_after_confirm(ctx) {
  const {m, offsets} = client(ctx);
  await m.replicateChange('rep-1', 0, change(1));
  ctx.grpc.fail('ApplyChange', ctx.grpc.status.UNAVAILABLE, '', 20);
  let returned = false;
  try {
    await m.replicateChange('rep-1', 0, change(2));
    returned = true;
  } catch {
    // expected: the target never confirmed
  }
  assert(!returned, 'replicateChange resolved although the target never confirmed change c-2');
  const resumed = await offsets.resumeOffset('rep-1', 0);
  assert.equal(resumed, 1, \`the target never confirmed c-2 and the shard offset is \${resumed}, expected 1: a restart would skip c-2\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "replication/gen/replicator"
	"replication/offsets"

	"leetbuild/harness"
)

const schemaDiff = "orders.discount_code: text at the source, missing at the target"

var clientBg = context.Background()

func change(n int64) Change {
	return Change{ChangeID: fmt.Sprintf("c-%d", n), Offset: n, Key: fmt.Sprintf("orders/%d", n), Value: fmt.Sprintf(\`{"total": %d00}\`, n)}
}

// targetPeer dedupes by change_id; loseReplies drops the reply of that many applied calls.
type targetPeer struct {
	pb.UnimplementedTargetRegionServer
	applied     []string
	loseReplies int
	mismatched  map[string]bool
}

func (t *targetPeer) ApplyChange(_ context.Context, req *pb.ApplyChangeRequest) (*pb.ApplyChangeReply, error) {
	if t.mismatched[req.GetKey()] {
		return nil, status.Error(codes.FailedPrecondition, schemaDiff)
	}
	for _, id := range t.applied {
		if id == req.GetChangeId() {
			return &pb.ApplyChangeReply{Duplicate: true}, nil
		}
	}
	t.applied = append(t.applied, req.GetChangeId())
	if t.loseReplies > 0 {
		t.loseReplies--
		return nil, status.Error(codes.Unavailable, "connection reset after the write committed")
	}
	return &pb.ApplyChangeReply{}, nil
}

func client(ctx *harness.Ctx) *targetPeer {
	t := &targetPeer{mismatched: map[string]bool{}}
	pb.RegisterTargetRegionServer(ctx.GRPC.Server(""), t)
	return t
}

func mustFail(ctx *harness.Ctx, c Change, target error, why string) error {
	offset, err := replicateChange(clientBg, "rep-1", 0, c)
	ctx.Assert(err != nil, "%s: replicateChange returned %d instead of an error wrapping %v", why, offset, target)
	ctx.ErrorIs(err, target, "%s: replicateChange returned %v", why, err)
	return err
}

func resumed(ctx *harness.Ctx) int64 {
	offset, err := offsets.ResumeOffset(clientBg, "rep-1", 0)
	ctx.NoError(err, "ResumeOffset")
	return offset
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	offset, err := replicateChange(clientBg, "rep-1", 0, change(1))
	ctx.NoError(err, "with a healthy target replicateChange failed")
	ctx.Equal(offset, int64(1), "with a healthy target replicateChange must return the shard's offset")
	for _, call := range ctx.GRPC.CallsTo("ApplyChange", "") {
		ctx.Assert(call.HasDeadline(), "an ApplyChange call carries no deadline: a target that stops answering holds the worker")
		ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "an ApplyChange call carries a %v deadline, expected 3 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("ApplyChange", 10.0, "")
	before := len(ctx.GRPC.CallsTo("ApplyChange", ""))
	mustFail(ctx, change(2), ErrApplyFailed, "with a target slower than the deadline")
	made := len(ctx.GRPC.CallsTo("ApplyChange", "")) - before
	ctx.Assert(made <= 3, "a target slower than the deadline was called %d times, expected at most 3", made)
}

func CheckBoundedAttempts(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("ApplyChange", codes.InvalidArgument, "offset is not an integer", 1, "")
	mustFail(ctx, change(1), ErrApplyFailed, "with a request the target rejects (InvalidArgument)")
	ctx.Equal(len(ctx.GRPC.CallsTo("ApplyChange", "")), 1, "InvalidArgument must not be retried (only Unavailable, DeadlineExceeded and ResourceExhausted are); the calls")
	ctx.GRPC.Fail("ApplyChange", codes.Unavailable, "", 10, "")
	mustFail(ctx, change(2), ErrApplyFailed, "with the target unavailable")
	ctx.Equal(len(ctx.GRPC.CallsTo("ApplyChange", ""))-1, 3, "an unavailable target must be called maxAttempts = 3 times for one change; the calls")
}

func CheckChangeId(ctx *harness.Ctx) {
	t := client(ctx)
	t.loseReplies = 1
	offset, err := replicateChange(clientBg, "rep-1", 0, change(7))
	ctx.NoError(err, "replicateChange after one lost reply")
	var sent []string
	for _, call := range ctx.GRPC.CallsTo("ApplyChange", "") {
		sent = append(sent, call.Request.(*pb.ApplyChangeRequest).GetChangeId())
	}
	ctx.Assert(len(t.applied) == 1, "the reply of the first attempt was lost and the target applied the change %d times (change ids %q): every attempt must carry the change's own change_id", len(t.applied), sent)
	ctx.Assert(len(sent) > 0 && strings.Count(strings.Join(sent, ","), "c-7") == len(sent), "the attempts carried change ids %q, expected c-7 on each", sent)
	ctx.Equal(offset, int64(7), "replicateChange must return the shard's offset")
}

func CheckSchemaMismatch(ctx *harness.Ctx) {
	t := client(ctx)
	t.mismatched["orders/3"] = true
	err := mustFail(ctx, change(3), ErrSchemaMismatch, "with a change the target's schema lacks")
	ctx.Assert(strings.Contains(err.Error(), "discount_code"), "the schema mismatch must carry the target's diff, got %v", err)
	ctx.Equal(len(ctx.GRPC.CallsTo("ApplyChange", "")), 1, "a schema mismatch must be sent once: the target refuses it until its schema changes; the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a schema mismatch must not be slept on and retried; the sleeps")
	ctx.Equal(resumed(ctx), int64(0), "the shard's offset must not move past a change the target refused")
}

func CheckAdvanceAfterConfirm(ctx *harness.Ctx) {
	client(ctx)
	_, err := replicateChange(clientBg, "rep-1", 0, change(1))
	ctx.NoError(err, "replicateChange(c-1) with a healthy target")
	ctx.GRPC.Fail("ApplyChange", codes.Unavailable, "", 20, "")
	_, err = replicateChange(clientBg, "rep-1", 0, change(2))
	ctx.Assert(err != nil, "replicateChange returned no error although the target never confirmed change c-2")
	ctx.Equal(resumed(ctx), int64(1), "the target never confirmed c-2, so the shard's offset must stay at 1 or a restart skips c-2; the offset")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "replication/offsets.h"

namespace {

const std::string kDiff = "orders.discount_code: text at the source, missing at the target";

Change change(long long n) {
  return Change{"c-" + std::to_string(n), n, "orders/" + std::to_string(n), "{\\"total\\": " + std::to_string(n) + "00}"};
}

// The target region: dedupes by change_id; lose_replies drops the reply of that many applied calls.
class TargetPeer final : public replicatord::TargetRegion::Service {
 public:
  std::vector<std::string> applied;
  int lose_replies = 0;
  std::set<std::string> mismatched;
  grpc::Status ApplyChange(grpc::ServerContext*, const replicatord::ApplyChangeRequest* req, replicatord::ApplyChangeReply* out) override {
    if (mismatched.count(req->key())) return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, kDiff);
    if (std::find(applied.begin(), applied.end(), req->change_id()) != applied.end()) {
      out->set_duplicate(true);
      return grpc::Status::OK;
    }
    applied.push_back(req->change_id());
    if (lose_replies > 0) {
      lose_replies--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset after the write committed");
    }
    return grpc::Status::OK;
  }
};

TargetPeer& client(harness::Ctx& ctx) {
  static TargetPeer* peer = nullptr;
  delete peer;
  peer = new TargetPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

template <class E>
std::string mustThrow(harness::Ctx& ctx, const Change& c, const std::string& expected, const std::string& why) {
  long long offset = 0;
  try {
    offset = replicateChange("rep-1", 0, c);
  } catch (const E& e) {
    return e.what();
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: replicateChange threw %s: %s, expected %s", why, harness::CurrentExceptionType(), e.what(), expected);
  }
  ctx.Fatalf("%s: replicateChange returned %d instead of throwing %s", why, offset, expected);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(replicateChange("rep-1", 0, change(1)), 1, "with a healthy target replicateChange must return the shard's offset");
  for (const auto& call : ctx.GRPC.CallsTo("ApplyChange")) {
    ctx.Assert(call.HasDeadline(), "an ApplyChange call carries no deadline: a target that stops answering holds the worker");
    ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "an ApplyChange call carries a %v s deadline, expected kApplyDeadline = 3 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("ApplyChange", 10.0);
  const std::size_t before = ctx.GRPC.CallsTo("ApplyChange").size();
  mustThrow<ApplyFailed>(ctx, change(2), "ApplyFailed", "with a target slower than the deadline");
  const std::size_t made = ctx.GRPC.CallsTo("ApplyChange").size() - before;
  ctx.Assert(made <= 3, "a target slower than the deadline was called %d times, expected at most 3", made);
}

void CheckBoundedAttempts(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("ApplyChange", grpc::StatusCode::INVALID_ARGUMENT, "offset is not an integer", 1);
  mustThrow<ApplyFailed>(ctx, change(1), "ApplyFailed", "with a request the target rejects (INVALID_ARGUMENT)");
  ctx.Equal(ctx.GRPC.CallsTo("ApplyChange").size(), 1, "INVALID_ARGUMENT must not be retried (only UNAVAILABLE, DEADLINE_EXCEEDED and RESOURCE_EXHAUSTED are); the calls");
  ctx.GRPC.Fail("ApplyChange", grpc::StatusCode::UNAVAILABLE, "", 10);
  mustThrow<ApplyFailed>(ctx, change(2), "ApplyFailed", "with the target unavailable");
  ctx.Equal(ctx.GRPC.CallsTo("ApplyChange").size() - 1, 3, "an unavailable target must be called kMaxAttempts = 3 times for one change; the calls");
}

void CheckChangeId(harness::Ctx& ctx) {
  TargetPeer& target = client(ctx);
  target.lose_replies = 1;
  const long long offset = replicateChange("rep-1", 0, change(7));
  std::vector<std::string> sent;
  for (const auto& call : ctx.GRPC.CallsTo("ApplyChange")) sent.push_back(call.Request<replicatord::ApplyChangeRequest>().change_id());
  ctx.Assert(target.applied.size() == 1, "the reply of the first attempt was lost and the target applied the change %d times (change ids %q): every attempt must carry the change's own change_id", target.applied.size(), sent);
  ctx.Assert(!sent.empty() && std::all_of(sent.begin(), sent.end(), [](const std::string& s) { return s == "c-7"; }), "the attempts carried change ids %q, expected c-7 on each", sent);
  ctx.Equal(offset, 7, "replicateChange must return the shard's offset");
}

void CheckSchemaMismatch(harness::Ctx& ctx) {
  TargetPeer& target = client(ctx);
  target.mismatched.insert("orders/3");
  const std::string message = mustThrow<SchemaMismatch>(ctx, change(3), "SchemaMismatch", "with a change the target's schema lacks");
  ctx.Assert(message.find("discount_code") != std::string::npos, "SchemaMismatch must carry the target's diff, got %s", message);
  ctx.Equal(ctx.GRPC.CallsTo("ApplyChange").size(), 1, "a schema mismatch must be sent once: the target refuses it until its schema changes; the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a schema mismatch must not be slept on and retried; the sleeps");
  ctx.Equal(offsets::resumeOffset("rep-1", 0), 0, "the shard's offset must not move past a change the target refused");
}

void CheckAdvanceAfterConfirm(harness::Ctx& ctx) {
  client(ctx);
  replicateChange("rep-1", 0, change(1));
  ctx.GRPC.Fail("ApplyChange", grpc::StatusCode::UNAVAILABLE, "", 20);
  bool returned = false;
  try {
    replicateChange("rep-1", 0, change(2));
    returned = true;
  } catch (const std::exception&) {
  }
  ctx.Assert(!returned, "replicateChange returned although the target never confirmed change c-2");
  ctx.Equal(offsets::resumeOffset("rep-1", 0), 1, "the target never confirmed c-2, so the shard's offset must stay at 1 or a restart skips c-2; the offset");
}
`,
  },
  hints: [
    'Drop the reply of one apply: the target holds the change twice. Make the target answer FAILED_PRECONDITION: the worker sleeps through eight attempts. Make it unavailable: the shard offset moves anyway.',
    'The request is rebuilt inside the loop with a new uuid, so the target cannot tell a retry from a new change; no call has a deadline; every error is retried; and the offset is advanced before the first call.',
    'Build the request once with `change_id=change["change_id"]`; loop `range(MAX_ATTEMPTS)` with `timeout=DEADLINE_S`; FAILED_PRECONDITION → `SchemaMismatch(details)`; non-retryable or last → `ApplyFailed`; call `advance_offset` after the loop.',
  ],
  debrief: `The change id is what makes a retry safe: a timeout says nothing about whether the target applied the change, so the only retry that cannot double a row is one the target recognises as the same change. Building the request once is how the code keeps that promise. The status code then decides the rest: unavailable and deadline exceeded are worth another attempt, a schema mismatch is a fact about the target that no retry changes, so the shard halts with the diff for an operator. Advancing the offset last ties the checkpoint to the target's confirmation. Production replicators retry from the shard's checkpoint rather than in a tight loop, add jitter to the backoff, and page someone when a shard halts.`,
};
