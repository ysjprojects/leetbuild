import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Warehouse writes with idempotent merge semantics',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it writes a partition, retries
when the warehouse is slow, and returns a row count. It appends a fresh statement on every retry, so
the demo load is fast and the retried load is wrong. Review it like the service owner, fix it, and
prove the fix.

Implement the warehouse client that writes one partition of a manifest over gRPC.

- Every attempt carries a **30-second deadline** (\`DEADLINE_S\`). A merge that hangs holds a worker
  and a warehouse slot; the deadline is what turns a stall into a retryable failure.
- A \`merge\` (and a \`replace\`) writes **keyed by \`(manifest id, partition id)\`**: the statement is
  a \`MERGE\` whose match condition is \`t.manifest_id = … AND t.partition_id = …\`, so a retried
  partition **replaces itself** instead of adding a second copy of the same rows. An \`append\` is
  only for a partition the progress set (step 2) says is new.
- Retry **only** the statuses that mean "try again": \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, at
  most \`MAX_ATTEMPTS\` (3) attempts with a growing backoff.
- \`PERMISSION_DENIED\` is **terminal**: stop the load and raise a visible reason
  (\`LoadFailed\`) — a credential problem never fixes itself by retrying, and the operator needs to
  see which target and partition were refused.
- The row count returned is the **warehouse's** count for the successful attempt
  (\`reply.rows_written\`), **assigned** — never accumulated across attempts. Adding every attempt's
  count is how a single day of orders is reported as two.

**Failure mode the checks target.** A fresh append on retry duplicates rows in the warehouse and the
duplicate is invisible in the count because the loader keeps adding its own attempts; a missing
deadline turns a slow warehouse into a stuck worker; and treating \`PERMISSION_DENIED\` as retryable
burns the retry budget on a request that can never succeed.`,
  sequence: {
    participants: ['Load worker', 'Warehouse', 'Load report'],
    messages: [
      {
        from: 'Load worker',
        to: 'Warehouse',
        label: 'Write · MERGE ON (manifest_id, partition_id) · deadline 30s',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Load worker', label: 'rows_written', kind: 'reply'},
      {from: 'Warehouse', to: 'Load worker', label: 'UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Load worker', to: 'Warehouse', label: 'retry the same keyed statement · ≤ 3 attempts', kind: 'sync'},
      {from: 'Warehouse', to: 'Load worker', label: 'PERMISSION_DENIED', kind: 'reply'},
      {from: 'Load worker', to: 'Load report', label: 'stop the load · reason = target + partition', kind: 'async'},
      {from: 'Load report', to: 'Load worker', label: 'visible reason, no retry', kind: 'reply'},
    ],
  },
  hints: [
    'Write the statement before the loop, once. The key is `(manifest id, partition id)` inside the statement, so the retry re-sends the *same* statement — that is the whole idempotence of a merge: the warehouse deletes the partition’s rows and inserts them again.',
    'Classify the error inside a `try`/`catch`: `UNUNAVAILABLE`/`DEADLINE_EXCEEDED` may retry (bounded by `MAX_ATTEMPTS`) with a backoff, `PERMISSION_DENIED` never does — it must surface the target and the partition so on-call can fix the grant.',
    'Return the reply’s count, do not sum it. `total += reply.rows_written` inside the retry loop counts the failed attempt as well; assign `rows_written = reply.rows_written` only on the successful attempt, and the number reconciles against the warehouse however many times you retried.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Puts a 30-second deadline on every attempt',
      detail:
        'Each attempt calls the warehouse under a `DEADLINE_S` (30s) deadline. The draft calls without one, so a slow warehouse pins the worker forever.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_S/, /DEADLINE_S \* 1000/]},
        go: {all: [/deadlineS/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineS/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineS/, /set_deadline\(/]},
      },
    },
    {
      id: 'merge-key',
      title: 'Merges on (manifest id, partition id) so a retry replaces itself',
      detail:
        'The statement is a `MERGE` matching `t.manifest_id = … AND t.partition_id = …`. The draft builds a fresh `INSERT … SELECT` on every retry, so the retried partition is written twice.',
      match: {
        python: {all: [/MERGE/, /manifest_id/, /partition_id/]},
        typescript: {all: [/MERGE/, /manifest_id/, /partition_id/]},
        go: {all: [/MERGE/, /manifest_id/, /partition_id/]},
        scala: {all: [/MERGE/, /manifest_id/, /partition_id/]},
        cpp: {all: [/MERGE/, /manifest_id/, /partition_id/]},
      },
    },
    {
      id: 'retry-classification',
      title: 'Retries only the retryable statuses and stops on PERMISSION_DENIED',
      detail:
        '`UNAVAILABLE` and `DEADLINE_EXCEEDED` retry; `PERMISSION_DENIED` stops the load with a visible reason and no further attempt. The draft catches every error and retries forever.',
      match: {
        python: {all: [/UNAVAILABLE/, /PERMISSION_DENIED/, /RETRYABLE/]},
        typescript: {all: [/UNAVAILABLE/, /PERMISSION_DENIED/, /RETRYABLE/]},
        go: {all: [/Unavailable/, /PermissionDenied/, /retryable/]},
        scala: {all: [/UNAVAILABLE/, /PERMISSION_DENIED/, /Retryable/]},
        cpp: {all: [/UNAVAILABLE/, /PERMISSION_DENIED/, /retryable/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'Bounds the attempts and backs off',
      detail:
        'At most `MAX_ATTEMPTS` (3) attempts, sleeping between them. The draft loops without a bound, so one bad partition retries forever.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /time\.sleep\(/]},
        typescript: {all: [/MAX_ATTEMPTS/, /setTimeout\(/]},
        go: {all: [/maxAttempts/, /time\.Sleep\(/]},
        scala: {all: [/MaxAttempts/, /Thread\.sleep\(/]},
        cpp: {all: [/kMaxAttempts/, /sleep_for/]},
      },
    },
    {
      id: 'reconcile',
      title: 'Reports the warehouse count for the successful attempt',
      detail:
        'The count comes from the reply of the attempt that succeeded and is assigned, not accumulated: `rows_written = reply.rows_written`. The draft does `rows_written += reply.rows_written` inside the loop, so every retry inflates the total.',
      match: {
        python: {all: [/reply\.rows_written/], none: [/rows_written\s*\+=/]},
        typescript: {all: [/reply\.rows_written/], none: [/rowsWritten\s*\+=/]},
        go: {all: [/reply\.RowsWritten/], none: [/rowsWritten\s*\+=/]},
        scala: {all: [/reply\.rowsWritten/], none: [/rowsWritten\s*\+=/]},
        cpp: {all: [/reply\.rows_written\(\)/], none: [/rows_written\s*\+=|rowsWritten\s*\+=/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

from warehouse_pb2 import WritePartitionRequest
from warehouse_pb2_grpc import WarehouseStub


def write_partition(stub: WarehouseStub, target: str, manifest_id: str, partition_id: str, transform_sql: str, mode: str) -> int:
    # TODO: this draft builds a fresh append statement on every retry, calls without a deadline,
    # retries every error including PERMISSION_DENIED, and adds each attempt's rows to a running
    # total. Review all four.
    statement = f"INSERT INTO {target} SELECT * FROM ({transform_sql}) AS s"
    request = WritePartitionRequest(target=target, partition_id=partition_id, statement=statement)
    rows_written = 0
    while True:
        try:
            reply = stub.Write(request)
            rows_written += reply.rows_written
            return rows_written
        except Exception:
            continue
`,
      solution: `import time

import grpc

from warehouse_pb2 import WritePartitionRequest
from warehouse_pb2_grpc import WarehouseStub

DEADLINE_S = 30
MAX_ATTEMPTS = 3
RETRY_BACKOFF_S = 0.5
RETRYABLE_STATUSES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

MERGE_KEY_SQL = (
    "MERGE INTO {target} AS t USING ({sql}) AS s "
    "ON t.manifest_id = '{manifest_id}' AND t.partition_id = '{partition_id}' "
    "WHEN MATCHED THEN DELETE "
    "WHEN NOT MATCHED THEN INSERT (manifest_id, partition_id, id, payload) "
    "SELECT '{manifest_id}', '{partition_id}', s.id, s.payload FROM s"
)
APPEND_SQL = "INSERT INTO {target} SELECT * FROM ({sql}) AS s"


class LoadFailed(Exception):
    """A load that must stop: the caller surfaces \`reason\` to the operator."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def statement_for(target: str, transform_sql: str, manifest_id: str, partition_id: str, mode: str) -> str:
    """One statement per partition: a merge keyed by (manifest id, partition id) replaces, never appends."""
    if mode in ("merge", "replace"):
        return MERGE_KEY_SQL.format(
            target=target, sql=transform_sql, manifest_id=manifest_id, partition_id=partition_id
        )
    return APPEND_SQL.format(target=target, sql=transform_sql)


def write_partition(
    stub: WarehouseStub, target: str, manifest_id: str, partition_id: str, transform_sql: str, mode: str, token: str
) -> int:
    """Write one partition; returns the row count the warehouse reports for the successful attempt."""
    request = WritePartitionRequest(
        target=target,
        partition_id=partition_id,
        statement=statement_for(target, transform_sql, manifest_id, partition_id, mode),
    )
    attempt = 0
    while attempt < MAX_ATTEMPTS:
        attempt += 1
        try:
            reply = stub.Write(request, timeout=DEADLINE_S, metadata=(("authorization", token),))
            return reply.rows_written  # authoritative for this attempt; never accumulated
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.PERMISSION_DENIED:
                raise LoadFailed(f"PERMISSION_DENIED writing {target} partition {partition_id}: {err.details()}") from err
            if code not in RETRYABLE_STATUSES or attempt == MAX_ATTEMPTS:
                raise LoadFailed(f"{code.name} writing {target} partition {partition_id}: {err.details()}") from err
            time.sleep(RETRY_BACKOFF_S * attempt)
    raise LoadFailed(f"{target} partition {partition_id}: no attempt left")
`,
    },
    typescript: {
      starter: `/** Warehouse writes: a model-generated draft that appends a fresh statement on every retry. */
import * as grpc from '@grpc/grpc-js';

interface WriteRequest {
  target: string;
  partition_id: string;
  statement: string;
}

interface WriteReply {
  rows_written: number;
}

interface WarehouseClient extends grpc.Client {
  write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (err: grpc.ServiceError | null, reply: WriteReply) => void): grpc.ClientUnaryCall;
}

export async function writePartition(
  client: WarehouseClient,
  target: string,
  manifestId: string,
  partitionId: string,
  transformSql: string,
  mode: string,
): Promise<number> {
  // TODO: this draft builds a fresh append statement on every retry, calls without a deadline,
  // retries every error including PERMISSION_DENIED, and adds each attempt's rows to a running
  // total. Review all four.
  let rowsWritten = 0;
  for (;;) {
    const statement = \`INSERT INTO \${target} SELECT * FROM (\${transformSql}) AS s\`;
    const request: WriteRequest = {target, partition_id: partitionId, statement};
    try {
      const reply = await callWrite(client, request, new grpc.Metadata(), {});
      rowsWritten += reply.rows_written;
      return rowsWritten;
    } catch {
      continue;
    }
  }
}

function callWrite(
  client: WarehouseClient,
  request: WriteRequest,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
): Promise<WriteReply> {
  const {promise, resolve, reject} = Promise.withResolvers<WriteReply>();
  client.write(request, metadata, options, (err, reply) => {
    if (err) reject(err);
    else resolve(reply);
  });
  return promise;
}
`,
      solution: `/** Warehouse writes: one keyed statement per partition, a deadline, and bounded retries. */
import * as grpc from '@grpc/grpc-js';

export const DEADLINE_S = 30;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const RETRYABLE_STATUSES: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

const MERGE_KEY_SQL = \`MERGE INTO {target} AS t USING ({sql}) AS s
ON t.manifest_id = '{manifest_id}' AND t.partition_id = '{partition_id}'
WHEN MATCHED THEN DELETE
WHEN NOT MATCHED THEN INSERT (manifest_id, partition_id, id, payload)
SELECT '{manifest_id}', '{partition_id}', s.id, s.payload FROM s\`;
const APPEND_SQL = 'INSERT INTO {target} SELECT * FROM ({sql}) AS s';

interface WriteRequest {
  target: string;
  partition_id: string;
  statement: string;
}

interface WriteReply {
  rows_written: number;
}

interface WarehouseClient extends grpc.Client {
  write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (err: grpc.ServiceError | null, reply: WriteReply) => void): grpc.ClientUnaryCall;
}

export class LoadFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** One statement per partition: merge/replace key on (manifest id, partition id), append only when new. */
function statementFor(
  target: string,
  transformSql: string,
  manifestId: string,
  partitionId: string,
  mode: string,
): string {
  if (mode === 'merge' || mode === 'replace') {
    return MERGE_KEY_SQL.replaceAll('{target}', target)
      .replaceAll('{sql}', transformSql)
      .replaceAll('{manifest_id}', manifestId)
      .replaceAll('{partition_id}', partitionId);
  }
  return APPEND_SQL.replaceAll('{target}', target).replaceAll('{sql}', transformSql);
}

function callWrite(
  client: WarehouseClient,
  request: WriteRequest,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
): Promise<WriteReply> {
  const {promise, resolve, reject} = Promise.withResolvers<WriteReply>();
  client.write(request, metadata, options, (err, reply) => {
    if (err) reject(err);
    else resolve(reply);
  });
  return promise;
}

export async function writePartition(
  client: WarehouseClient,
  target: string,
  manifestId: string,
  partitionId: string,
  transformSql: string,
  mode: string,
  token: string,
): Promise<number> {
  const request: WriteRequest = {
    target,
    partition_id: partitionId,
    statement: statementFor(target, transformSql, manifestId, partitionId, mode),
  };
  const metadata = new grpc.Metadata();
  metadata.set('authorization', token);
  const deadline = new Date(Date.now() + DEADLINE_S * 1000);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await callWrite(client, request, metadata, {deadline});
      return reply.rows_written; // authoritative for this attempt; never accumulated
    } catch (err) {
      const code = (err as grpc.ServiceError).code;
      if (code === grpc.status.PERMISSION_DENIED) {
        throw new LoadFailed(
          \`PERMISSION_DENIED writing \${target} partition \${partitionId}: \${(err as grpc.ServiceError).details}\`,
        );
      }
      if (RETRYABLE_STATUSES[code] !== true || attempt === MAX_ATTEMPTS) {
        throw new LoadFailed(\`\${code} writing \${target} partition \${partitionId}\`);
      }
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, RETRY_BACKOFF_MS * attempt);
      await promise;
    }
  }
  throw new LoadFailed(\`\${target} partition \${partitionId}: no attempt left\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	pb "loader/warehousepb"
)

// WritePartition writes one partition of a manifest and returns the rows it wrote.
func WritePartition(ctx context.Context, client pb.WarehouseClient, target, manifestID, partitionID, transformSQL, mode, token string) (int64, error) {
	// TODO: this draft builds a fresh append statement on every retry, calls without a deadline,
	// retries every error including PERMISSION_DENIED, and adds each attempt's rows to a running
	// total. Review all four.
	statement := fmt.Sprintf("INSERT INTO %s SELECT * FROM (%s) AS s", target, transformSQL)
	request := &pb.WritePartitionRequest{Target: target, PartitionId: partitionID, Statement: statement}
	rowsWritten := int64(0)
	for {
		reply, err := client.Write(ctx, request)
		if err != nil {
			continue
		}
		rowsWritten += reply.RowsWritten
		return rowsWritten, nil
	}
}
`,
      solution:
        `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "loader/warehousepb"
)

const (
	deadlineS      = 30 * time.Second
	maxAttempts    = 3
	retryBackoffMS = 500
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

const mergeKeySQL = ` +
        '`' +
        `MERGE INTO %s AS t USING (%s) AS s
ON t.manifest_id = '%s' AND t.partition_id = '%s'
WHEN MATCHED THEN DELETE
WHEN NOT MATCHED THEN INSERT (manifest_id, partition_id, id, payload)
SELECT '%s', '%s', s.id, s.payload FROM s` +
        '`' +
        `

const appendSQL = ` +
        '`' +
        `INSERT INTO %s SELECT * FROM (%s) AS s` +
        '`' +
        `

// LoadFailed is terminal: the reason names the target and the partition that failed.
type LoadFailed struct{ Reason string }

func (e *LoadFailed) Error() string {
	return "load failed: " + e.Reason
}

// statementFor builds one statement per partition: merge/replace key on (manifest id, partition id).
func statementFor(target, transformSQL, manifestID, partitionID, mode string) string {
	if mode == "merge" || mode == "replace" {
		return fmt.Sprintf(mergeKeySQL, target, transformSQL, manifestID, partitionID, manifestID, partitionID)
	}
	return fmt.Sprintf(appendSQL, target, transformSQL)
}

// WritePartition writes one partition under a deadline and returns the warehouse's row count.
func WritePartition(ctx context.Context, client pb.WarehouseClient, target, manifestID, partitionID, transformSQL, mode, token string) (int64, error) {
	request := &pb.WritePartitionRequest{
		Target:      target,
		PartitionId: partitionID,
		Statement:   statementFor(target, transformSQL, manifestID, partitionID, mode),
	}
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", token)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineS)
		reply, err := client.Write(callCtx, request)
		cancel()
		if err == nil {
			return reply.RowsWritten, nil // authoritative for this attempt; never accumulated
		}
		code := status.Code(err)
		if code == codes.PermissionDenied {
			return 0, &LoadFailed{Reason: fmt.Sprintf("PERMISSION_DENIED writing %s partition %s: %v", target, partitionID, err)}
		}
		if !retryable[code] || attempt == maxAttempts {
			return 0, &LoadFailed{Reason: fmt.Sprintf("%s writing %s partition %s: %v", code, target, partitionID, err)}
		}
		time.Sleep(time.Duration(retryBackoffMS*attempt) * time.Millisecond)
	}
	return 0, &LoadFailed{Reason: fmt.Sprintf("%s partition %s: no attempt left", target, partitionID)}
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannel
import loader.warehouse.{WarehouseGrpc, WritePartitionRequest}

object WarehouseWriter {
  def writePartition(stub: WarehouseGrpc.WarehouseBlockingStub, target: String, manifestId: String, partitionId: String,
                     transformSql: String, mode: String): Long = {
    // TODO: this draft builds a fresh append statement on every retry, calls without a deadline,
    // retries every error including PERMISSION_DENIED, and adds each attempt's rows to a running
    // total. Review all four.
    var rowsWritten = 0L
    var done = false
    while (!done) {
      val statement = s"INSERT INTO $target SELECT * FROM ($transformSql) AS s"
      val reply = stub.write(WritePartitionRequest(target = target, partitionId = partitionId, statement = statement))
      rowsWritten += reply.rowsWritten
      done = true
    }
    rowsWritten
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.stub.MetadataUtils
import io.grpc.{Metadata, Status, StatusRuntimeException}
import loader.warehouse.{WarehouseGrpc, WritePartitionRequest}

object WarehouseWriter {
  val DeadlineS = 30L
  val MaxAttempts = 3
  val RetryBackoffMillis = 500L

  val MergeKeySql =
    """MERGE INTO %s AS t USING (%s) AS s
      |ON t.manifest_id = '%s' AND t.partition_id = '%s'
      |WHEN MATCHED THEN DELETE
      |WHEN NOT MATCHED THEN INSERT (manifest_id, partition_id, id, payload)
      |SELECT '%s', '%s', s.id, s.payload FROM s""".stripMargin

  val AppendSql = "INSERT INTO %s SELECT * FROM (%s) AS s"

  /** Retry only the statuses that mean "try again". */
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  /** Terminal: the reason names the target and the partition that failed. */
  final case class LoadFailed(reason: String) extends RuntimeException(reason)

  /** One statement per partition: merge/replace key on (manifest id, partition id). */
  def statementFor(target: String, transformSql: String, manifestId: String, partitionId: String, mode: String): String =
    if (mode == "merge" || mode == "replace")
      MergeKeySql.format(target, transformSql, manifestId, partitionId, manifestId, partitionId)
    else AppendSql.format(target, transformSql)

  /** Write one partition under a deadline; returns the warehouse's row count for the successful attempt. */
  def writePartition(stub: WarehouseGrpc.WarehouseBlockingStub, target: String, manifestId: String, partitionId: String,
                     transformSql: String, mode: String, token: String): Long = {
    val request = WritePartitionRequest(
      target = target,
      partitionId = partitionId,
      statement = statementFor(target, transformSql, manifestId, partitionId, mode)
    )
    val headers = new Metadata()
    headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), token)
    val callStub = stub.withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = callStub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).write(request)
        return reply.rowsWritten // authoritative for this attempt; never accumulated
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.PERMISSION_DENIED) {
            throw LoadFailed(s"PERMISSION_DENIED writing $target partition $partitionId: \${e.getStatus.getDescription}")
          }
          if (!Retryable.contains(code) || attempt == MaxAttempts) {
            throw LoadFailed(s"$code writing $target partition $partitionId: \${e.getStatus.getDescription}")
          }
          Thread.sleep(RetryBackoffMillis * attempt)
          attempt += 1
      }
    }
    throw LoadFailed(s"$target partition $partitionId: no attempt left")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "warehouse.grpc.pb.h"

// Writes one partition of a manifest and returns the rows it wrote.
long writePartition(warehouse::Warehouse::Stub* stub, const std::string& target, const std::string& manifestId,
                    const std::string& partitionId, const std::string& transformSql, const std::string& mode) {
  // TODO: this draft builds a fresh append statement on every retry, calls without a deadline,
  // retries every error including PERMISSION_DENIED, and adds each attempt's rows to a running
  // total. Review all four.
  long rowsWritten = 0;
  for (;;) {
    grpc::ClientContext ctx;
    warehouse::WritePartitionRequest request;
    request.set_target(target);
    request.set_partition_id(partitionId);
    request.set_statement("INSERT INTO " + target + " SELECT * FROM (" + transformSql + ") AS s");
    warehouse::WritePartitionReply reply;
    const grpc::Status status = stub->Write(&ctx, request, &reply);
    if (status.ok()) {
      rowsWritten += reply.rows_written();
      return rowsWritten;
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>

#include "warehouse.grpc.pb.h"

constexpr int kDeadlineS = 30;
constexpr int kMaxAttempts = 3;
constexpr int kRetryBackoffMs = 500;

const std::string kMergeKeySql = R"sql(MERGE INTO %s AS t USING (%s) AS s
ON t.manifest_id = '%s' AND t.partition_id = '%s'
WHEN MATCHED THEN DELETE
WHEN NOT MATCHED THEN INSERT (manifest_id, partition_id, id, payload)
SELECT '%s', '%s', s.id, s.payload FROM s)sql";

const std::string kAppendSql = "INSERT INTO %s SELECT * FROM (%s) AS s";

// Terminal: the reason names the target and the partition that failed.
class LoadFailed : public std::runtime_error {
 public:
  explicit LoadFailed(const std::string& reason) : std::runtime_error(reason) {}
};

// Retry only the statuses that mean "try again".
bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// One statement per partition: merge/replace key on (manifest id, partition id).
std::string statementFor(const std::string& target, const std::string& transformSql, const std::string& manifestId,
                         const std::string& partitionId, const std::string& mode) {
  char buf[2048];
  if (mode == "merge" || mode == "replace") {
    std::snprintf(buf, sizeof buf, kMergeKeySql.c_str(), target.c_str(), transformSql.c_str(), manifestId.c_str(),
                  partitionId.c_str(), manifestId.c_str(), partitionId.c_str());
  } else {
    std::snprintf(buf, sizeof buf, kAppendSql.c_str(), target.c_str(), transformSql.c_str());
  }
  return std::string(buf);
}

// Writes one partition under a deadline and returns the warehouse's row count.
long writePartition(warehouse::Warehouse::Stub* stub, const std::string& target, const std::string& manifestId,
                    const std::string& partitionId, const std::string& transformSql, const std::string& mode,
                    const std::string& token) {
  warehouse::WritePartitionRequest request;
  request.set_target(target);
  request.set_partition_id(partitionId);
  request.set_statement(statementFor(target, transformSql, manifestId, partitionId, mode));
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
    ctx.AddMetadata("authorization", token);
    warehouse::WritePartitionReply reply;
    const grpc::Status status = stub->Write(&ctx, request, &reply);
    if (status.ok()) return reply.rows_written();  // authoritative for this attempt; never accumulated
    if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) {
      throw LoadFailed("PERMISSION_DENIED writing " + target + " partition " + partitionId + ": " +
                       status.error_message());
    }
    if (!retryable(status.error_code()) || attempt == kMaxAttempts) {
      throw LoadFailed("write failed for " + target + " partition " + partitionId + ": " + status.error_message());
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(kRetryBackoffMs * attempt));
  }
  throw LoadFailed(target + " partition " + partitionId + ": no attempt left");
}
`,
    },
  },
  debrief: `The interviewer is testing retry semantics, which is where data platforms lose data quietly. The
draft's retry looks careful — it re-sends a statement and reports a total — but the statement is an
append, so attempt two writes the partition's rows a second time, and the total is accumulated from
every attempt, so the inflated number looks like success. The fix is three coupled decisions: the
statement is built once and keyed by (manifest id, partition id) so the warehouse itself dedupes the
retry; only UNAVAILABLE and DEADLINE_EXCEEDED are retryable, and PERMISSION_DENIED surfaces a reason
that names the target; and the count reported is the warehouse's count for the attempt that succeeded.
The deadline is what makes the retry reachable at all — without it a stalled write never becomes
DEADLINE_EXCEEDED, it just holds the worker.`,
};
