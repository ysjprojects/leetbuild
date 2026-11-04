import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Shard writes with a deadline, a bounded retry set and one batch id',
  concept: 'grpc',
  file: 'client',
  focus: ['writer', 'shard'],
  task: `## Task

**Starting point.** The starter's \`bulk_write(index, records)\` calls
\`logshard.IndexShard/BulkWrite\` on \`shard:9000\` in a loop: each pass mints a batch id, sends
\`{index, batch_id, attempt, records}\`, returns \`{batch_id, indexed, rejected, index_snapshot}\` on
success, and on any \`RpcError\` sleeps 200 ms and tries again, up to five times, before raising
\`ShardWriteFailed\`. \`MappingConflict\` and \`ShardWriteFailed\` come from \`logindex.shard\`. It
serves the demo and hides four flaws.

**Failure mode the checks target.** A hung shard holds the writer without end; an outage is
hammered five times; a mapping conflict, which no retry can fix, is retried and reported as an
outage; and a write whose reply was lost is indexed twice, because the retry carries a new batch id.

- Every attempt carries a **3-second deadline** (\`DEADLINE_S\`).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, at most \`MAX_ATTEMPTS = 3\` attempts in
  all, with a backoff between them; any other failure raises \`ShardWriteFailed\` at once.
- \`FAILED_PRECONDITION\` raises \`MappingConflict(field)\` with the field the shard named in the
  details, after one call.
- The batch id is minted **once, before the loop**; every attempt sends it, with its attempt number.`,
  sequence: {
    participants: ['Buffered writer', 'Index shard'],
    messages: [
      {from: 'Buffered writer', to: 'Index shard', label: 'BulkWrite{batch_id: b1, attempt: 1} · 3 s', kind: 'sync'},
      {from: 'Index shard', to: 'Buffered writer', label: 'UNAVAILABLE (written, reply lost)', kind: 'reply'},
      {from: 'Buffered writer', to: 'Buffered writer', label: 'retryable → backoff, same batch id', kind: 'sync'},
      {from: 'Buffered writer', to: 'Index shard', label: 'BulkWrite{batch_id: b1, attempt: 2} · 3 s', kind: 'sync'},
      {from: 'Index shard', to: 'Buffered writer', label: 'b1 already indexed → its first reply', kind: 'reply'},
      {
        from: 'Index shard',
        to: 'Buffered writer',
        label: 'FAILED_PRECONDITION "user_id" → MappingConflict',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 3-second deadline',
      detail:
        'Every BulkWrite carries a 3-second deadline, so a shard that stops answering costs three attempts of 3 s and a `ShardWriteFailed`; the starter sets none, and a hung shard holds the batch for as long as it hangs.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3\b/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\(ctx,\s*deadline\)/]},
        scala: {all: [/DeadlineS\s*=\s*3L/, /withDeadlineAfter\(DeadlineS/]},
        cpp: {all: [/kDeadline\{3\}/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-set',
      title: 'Retries UNAVAILABLE and DEADLINE_EXCEEDED only, three attempts at most',
      detail:
        'Two `UNAVAILABLE` answers are retried through to a success with a backoff between attempts; a longer outage stops at `MAX_ATTEMPTS = 3`; any other status is not retried. The starter retries every status five times.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS\s*=\s*3\b/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS\s*=\s*3\b/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /maxAttempts\s*=\s*3\b/]},
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MaxAttempts\s*=\s*3\b/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kMaxAttempts\s*=\s*3\b/]},
      },
    },
    {
      id: 'terminal-conflict',
      title: 'Raises a mapping conflict with its field, after one call',
      detail:
        '`FAILED_PRECONDITION` raises `MappingConflict` carrying the field from the details, with no retry and no sleep; the starter retries the conflict five times and reports it as `ShardWriteFailed`.',
      match: {
        python: {all: [/FAILED_PRECONDITION/, /raise MappingConflict\(/]},
        typescript: {all: [/FAILED_PRECONDITION/, /throw new MappingConflict\(/]},
        go: {all: [/codes\.FailedPrecondition/, /&shard\.MappingConflict\{/]},
        scala: {all: [/FAILED_PRECONDITION/, /throw new MappingConflict\(/]},
        cpp: {all: [/FAILED_PRECONDITION/, /throw shard::MappingConflict\(/]},
      },
    },
    {
      id: 'stable-batch-id',
      title: 'Sends one batch id on every attempt',
      detail:
        'The batch id is minted once before the retry loop, so a retry after a lost reply carries the id the shard already indexed and is answered without a second write; the starter mints one per attempt.',
      match: {
        python: {order: [/batch_id\s*=\s*str\(uuid\.uuid4\(\)\)/, /for attempt in/]},
        typescript: {order: [/const batchId = randomUUID\(\)/, /for \(let attempt/]},
        go: {order: [/batchID := uuid\.NewString\(\)/, /for attempt := 1/]},
        scala: {order: [/val batchId = UUID\.randomUUID\(\)/, /while \(/]},
        cpp: {order: [/const std::string batch_id = shard::newBatchId\(\)/, /for \(int attempt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import itertools
import time
import uuid

import grpc

import log_indexer_pb2
import log_indexer_pb2_grpc
from logindex.shard import MappingConflict, ShardWriteFailed

stub = log_indexer_pb2_grpc.IndexShardStub(grpc.insecure_channel("shard:9000"))


def bulk_write(index: str, records: list[dict]) -> dict:
    """Write one batch to the index: batch_id, indexed, rejected, index_snapshot."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    protos = [log_indexer_pb2.LogRecord(**record) for record in records]
    for attempt in itertools.count(1):
        batch_id = str(uuid.uuid4())
        request = log_indexer_pb2.BulkWriteRequest(index=index, batch_id=batch_id, attempt=attempt, records=protos)
        try:
            reply = stub.BulkWrite(request)
        except grpc.RpcError as exc:
            if attempt >= 5:
                raise ShardWriteFailed(f"{exc.code().name} after {attempt} attempt(s)") from exc
            time.sleep(0.2)  # the shard recovers quickly
            continue
        return {"batch_id": batch_id, "indexed": reply.indexed, "rejected": reply.rejected, "index_snapshot": reply.index_snapshot}
`,
      solution: `import time
import uuid

import grpc

import log_indexer_pb2
import log_indexer_pb2_grpc
from logindex.shard import MappingConflict, ShardWriteFailed

DEADLINE_S = 3
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

stub = log_indexer_pb2_grpc.IndexShardStub(grpc.insecure_channel("shard:9000"))


def bulk_write(index: str, records: list[dict]) -> dict:
    """Write one batch to the index: batch_id, indexed, rejected, index_snapshot."""
    # One id for every attempt: the shard indexes a batch id once, so a retry cannot duplicate.
    batch_id = str(uuid.uuid4())
    protos = [log_indexer_pb2.LogRecord(**record) for record in records]
    for attempt in range(1, MAX_ATTEMPTS + 1):
        request = log_indexer_pb2.BulkWriteRequest(index=index, batch_id=batch_id, attempt=attempt, records=protos)
        try:
            reply = stub.BulkWrite(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
                raise MappingConflict(exc.details()) from exc  # no retry changes the mapping
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise ShardWriteFailed(f"{exc.code().name} after {attempt} attempt(s)") from exc
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
            continue
        return {"batch_id": batch_id, "indexed": reply.indexed, "rejected": reply.rejected, "index_snapshot": reply.index_snapshot}
    raise ShardWriteFailed("no attempt was made")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import type {LogRecord} from 'logindex/buffer';
import {type ShardClient, type WriteResult, MappingConflict, ShardWriteFailed} from 'logindex/shard';

export {MappingConflict, ShardWriteFailed};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('log_indexer.proto')) as unknown as {
  logshard: {IndexShard: grpc.ServiceClientConstructor};
};
const shard = new pkg.logshard.IndexShard('shard:9000', grpc.credentials.createInsecure()) as ShardClient;

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Write one batch to the index. */
export async function bulkWrite(index: string, records: LogRecord[]): Promise<WriteResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 1; ; attempt += 1) {
    const batchId = randomUUID();
    try {
      const reply = await shard.BulkWrite({index, batch_id: batchId, attempt, records}, new grpc.Metadata(), {});
      return {batch_id: batchId, indexed: reply.indexed, rejected: reply.rejected, index_snapshot: reply.index_snapshot};
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (attempt >= 5) throw new ShardWriteFailed(\`\${grpc.status[code]} after \${attempt} attempt(s)\`);
      await sleep(200); // the shard recovers quickly
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import type {LogRecord} from 'logindex/buffer';
import {type ShardClient, type WriteResult, MappingConflict, ShardWriteFailed} from 'logindex/shard';

export {MappingConflict, ShardWriteFailed};

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 200;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('log_indexer.proto')) as unknown as {
  logshard: {IndexShard: grpc.ServiceClientConstructor};
};
const shard = new pkg.logshard.IndexShard('shard:9000', grpc.credentials.createInsecure()) as ShardClient;

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Write one batch to the index. */
export async function bulkWrite(index: string, records: LogRecord[]): Promise<WriteResult> {
  // One id for every attempt: the shard indexes a batch id once, so a retry cannot duplicate.
  const batchId = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await shard.BulkWrite({index, batch_id: batchId, attempt, records}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {batch_id: batchId, indexed: reply.indexed, rejected: reply.rejected, index_snapshot: reply.index_snapshot};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.FAILED_PRECONDITION) throw new MappingConflict(details); // no retry changes the mapping
      if (!RETRYABLE.includes(code) || attempt >= MAX_ATTEMPTS) throw new ShardWriteFailed(\`\${grpc.status[code]} after \${attempt} attempt(s)\`);
      await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"logindex/buffer" // buffer.Record
	"logindex/shard"  // shard.WriteResult, shard.MappingConflict, shard.ErrShardWriteFailed, shard.Protos
	pb "logindex/gen/log_indexer"
)

var (
	shardConn, _ = grpc.NewClient("shard:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	shardClient  = pb.NewIndexShardClient(shardConn)
)

// bulkWrite writes one batch to the index.
func bulkWrite(ctx context.Context, index string, records []buffer.Record) (shard.WriteResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	protos := shard.Protos(records)
	for attempt := 1; ; attempt++ {
		batchID := uuid.NewString()
		reply, err := shardClient.BulkWrite(ctx, &pb.BulkWriteRequest{Index: index, BatchId: batchID, Attempt: int32(attempt), Records: protos})
		if err == nil {
			return shard.WriteResult{BatchID: batchID, Indexed: int(reply.GetIndexed()), Rejected: int(reply.GetRejected()), IndexSnapshot: reply.GetIndexSnapshot()}, nil
		}
		if attempt >= 5 {
			return shard.WriteResult{}, fmt.Errorf("%w: %v after %d attempt(s)", shard.ErrShardWriteFailed, status.Code(err), attempt)
		}
		time.Sleep(200 * time.Millisecond) // the shard recovers quickly
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"logindex/buffer" // buffer.Record
	"logindex/shard"  // shard.WriteResult, shard.MappingConflict, shard.ErrShardWriteFailed, shard.Protos
	pb "logindex/gen/log_indexer"
)

const (
	deadline    = 3 * time.Second
	maxAttempts = 3
	backoff     = 200 * time.Millisecond
)

var (
	shardConn, _ = grpc.NewClient("shard:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	shardClient  = pb.NewIndexShardClient(shardConn)
)

// bulkWrite writes one batch to the index.
func bulkWrite(ctx context.Context, index string, records []buffer.Record) (shard.WriteResult, error) {
	// One id for every attempt: the shard indexes a batch id once, so a retry cannot duplicate.
	batchID := uuid.NewString()
	protos := shard.Protos(records)
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := shardClient.BulkWrite(callCtx, &pb.BulkWriteRequest{Index: index, BatchId: batchID, Attempt: int32(attempt), Records: protos})
		cancel()
		if err == nil {
			return shard.WriteResult{BatchID: batchID, Indexed: int(reply.GetIndexed()), Rejected: int(reply.GetRejected()), IndexSnapshot: reply.GetIndexSnapshot()}, nil
		}
		code := status.Code(err)
		if code == codes.FailedPrecondition {
			return shard.WriteResult{}, &shard.MappingConflict{Field: status.Convert(err).Message()} // no retry changes the mapping
		}
		if (code != codes.Unavailable && code != codes.DeadlineExceeded) || attempt >= maxAttempts {
			return shard.WriteResult{}, fmt.Errorf("%w: %v after %d attempt(s)", shard.ErrShardWriteFailed, code, attempt)
		}
		time.Sleep(backoff << (attempt - 1))
	}
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import logindex.{Buffer, MappingConflict, Shard, ShardWriteFailed} // Buffer.Record, Shard.WriteResult, Shard.protos
import logshard.log_indexer.{BulkWriteRequest, IndexShardGrpc}

object Client {
  private val stub = IndexShardGrpc.blockingStub(ManagedChannelBuilder.forAddress("shard", 9000).usePlaintext().build())

  /** Write one batch to the index. */
  def bulkWrite(index: String, records: Seq[Buffer.Record]): Shard.WriteResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    var attempt = 1
    var result: Option[Shard.WriteResult] = None
    while (result.isEmpty) {
      val batchId = UUID.randomUUID().toString
      try {
        val reply = stub.bulkWrite(BulkWriteRequest(index, batchId, attempt, Shard.protos(records)))
        result = Some(Shard.WriteResult(batchId, reply.indexed, reply.rejected, reply.indexSnapshot))
      } catch {
        case e: StatusRuntimeException =>
          if (attempt >= 5) throw new ShardWriteFailed(s"\${e.getStatus.getCode} after $attempt attempt(s)")
          Thread.sleep(200) // the shard recovers quickly
          attempt += 1
      }
    }
    result.get
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import logindex.{Buffer, MappingConflict, Shard, ShardWriteFailed} // Buffer.Record, Shard.WriteResult, Shard.protos
import logshard.log_indexer.{BulkWriteRequest, IndexShardGrpc}

object Client {
  val DeadlineS = 3L
  val MaxAttempts = 3
  val BackoffMs = 200L

  private val stub = IndexShardGrpc.blockingStub(ManagedChannelBuilder.forAddress("shard", 9000).usePlaintext().build())

  /** Write one batch to the index. */
  def bulkWrite(index: String, records: Seq[Buffer.Record]): Shard.WriteResult = {
    // One id for every attempt: the shard indexes a batch id once, so a retry cannot duplicate.
    val batchId = UUID.randomUUID().toString
    var attempt = 1
    var result: Option[Shard.WriteResult] = None
    while (result.isEmpty) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).bulkWrite(BulkWriteRequest(index, batchId, attempt, Shard.protos(records)))
        result = Some(Shard.WriteResult(batchId, reply.indexed, reply.rejected, reply.indexSnapshot))
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.FAILED_PRECONDITION =>
          throw new MappingConflict(Option(e.getStatus.getDescription).getOrElse("")) // no retry changes the mapping
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          val retryable = code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED
          if (!retryable || attempt >= MaxAttempts) throw new ShardWriteFailed(s"$code after $attempt attempt(s)")
          Thread.sleep(BackoffMs << (attempt - 1))
          attempt += 1
      }
    }
    result.get
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "log_indexer.grpc.pb.h"
#include "logindex/buffer.h"  // buffer::Record
#include "logindex/shard.h"   // shard::WriteResult, MappingConflict, ShardWriteFailed, newBatchId, request

auto shardStub = logshard::IndexShard::NewStub(grpc::CreateChannel("shard:9000", grpc::InsecureChannelCredentials()));

// Write one batch to the index.
shard::WriteResult bulkWrite(const std::string& index, const std::vector<buffer::Record>& records) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (int attempt = 1;; attempt++) {
    const std::string batch_id = shard::newBatchId();
    grpc::ClientContext ctx;
    logshard::BulkWriteReply reply;
    const grpc::Status status = shardStub->BulkWrite(&ctx, shard::request(index, batch_id, attempt, records), &reply);
    if (status.ok()) return {batch_id, reply.indexed(), reply.rejected(), reply.index_snapshot()};
    if (attempt >= 5) throw shard::ShardWriteFailed(status.error_message() + " after " + std::to_string(attempt) + " attempt(s)");
    std::this_thread::sleep_for(std::chrono::milliseconds{200});  // the shard recovers quickly
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "log_indexer.grpc.pb.h"
#include "logindex/buffer.h"  // buffer::Record
#include "logindex/shard.h"   // shard::WriteResult, MappingConflict, ShardWriteFailed, newBatchId, request

constexpr std::chrono::seconds kDeadline{3};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{200};

auto shardStub = logshard::IndexShard::NewStub(grpc::CreateChannel("shard:9000", grpc::InsecureChannelCredentials()));

// Write one batch to the index.
shard::WriteResult bulkWrite(const std::string& index, const std::vector<buffer::Record>& records) {
  // One id for every attempt: the shard indexes a batch id once, so a retry cannot duplicate.
  const std::string batch_id = shard::newBatchId();
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    logshard::BulkWriteReply reply;
    const grpc::Status status = shardStub->BulkWrite(&ctx, shard::request(index, batch_id, attempt, records), &reply);
    if (status.ok()) return {batch_id, reply.indexed(), reply.rejected(), reply.index_snapshot()};
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::FAILED_PRECONDITION) throw shard::MappingConflict(status.error_message());  // no retry changes the mapping
    const bool retryable = code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt >= kMaxAttempts) {
      throw shard::ShardWriteFailed(status.error_message() + " after " + std::to_string(attempt) + " attempt(s)");
    }
    std::this_thread::sleep_for(kBackoff * (1 << (attempt - 1)));
  }
}
`,
    },
  },
  harness: {
    python: `import grpc

import log_indexer_pb2
import log_indexer_pb2_grpc

INDEX = "logs-acme"
RECORDS = [
    {"service": "checkout", "timestamp": "2026-11-03T10:00:00Z", "level": "error", "message": "m-0"},
    {"service": "checkout", "timestamp": "2026-11-03T10:00:01Z", "level": "info", "message": "m-1"},
    {"service": "checkout", "timestamp": "2026-11-03T10:00:02Z", "level": "trace", "message": "m-2"},
]


class Shard(log_indexer_pb2_grpc.IndexShardServicer):
    """Indexes each batch id once (a trace record is rejected). conflict: refuse every batch naming
    that field; lose_reply: write, then answer UNAVAILABLE, that many times."""

    def __init__(self):
        self.batches = {}
        self.documents = 0
        self.conflict = ""
        self.lose_reply = 0

    def BulkWrite(self, request, context):
        if self.conflict:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, self.conflict)
        if request.batch_id not in self.batches:
            indexed = sum(1 for r in request.records if r.level != "trace")
            self.documents += indexed
            self.batches[request.batch_id] = log_indexer_pb2.BulkWriteReply(
                indexed=indexed, rejected=len(request.records) - indexed, index_snapshot=f"{request.index}@{len(self.batches) + 1}"
            )
        if self.lose_reply:
            self.lose_reply -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset after the write")
        return self.batches[request.batch_id]


def _client(ctx):
    shard = Shard()
    ctx.grpc.serve(log_indexer_pb2_grpc.add_IndexShardServicer_to_server, shard)
    return ctx.load("client"), shard


def _calls(ctx):
    return len(ctx.grpc.calls_to("BulkWrite"))


def _fails(m, exc, why):
    try:
        result = m.bulk_write(INDEX, RECORDS)
    except exc as e:
        return e
    except Exception as other:
        raise AssertionError(f"{why}: bulk_write raised {type(other).__name__}: {other}, expected {exc.__name__}")
    raise AssertionError(f"{why}: bulk_write returned {result} instead of raising {exc.__name__}")


def check_deadline(ctx):
    m, _ = _client(ctx)
    result = m.bulk_write(INDEX, RECORDS)
    assert result.get("indexed") == 2 and result.get("rejected") == 1 and result.get("index_snapshot") == "logs-acme@1", f"a healthy write must return the shard's reply (indexed 2, rejected 1, snapshot logs-acme@1), got {result}"
    for call in ctx.grpc.calls_to("BulkWrite"):
        assert call.timeout is not None, "a BulkWrite carries no deadline: a shard that stops answering holds the batch and its writer for as long as it hangs"
        assert 2.5 <= call.timeout <= 3.5, f"a BulkWrite carries a {call.timeout} s deadline, expected DEADLINE_S = 3"
    ctx.grpc.set_latency("BulkWrite", 10.0)
    before = _calls(ctx)
    _fails(m, m.ShardWriteFailed, "with the shard 10 s slow")
    assert _calls(ctx) - before == 3, f"a shard slower than the deadline was tried {_calls(ctx) - before} times, expected MAX_ATTEMPTS = 3"


def check_retry_set(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("BulkWrite", grpc.StatusCode.UNAVAILABLE, "shard restarting", times=2)
    result = m.bulk_write(INDEX, RECORDS)
    assert result.get("indexed") == 2, f"two UNAVAILABLE answers are retryable: the third attempt must succeed, got {result}"
    assert _calls(ctx) == 3, f"two UNAVAILABLE answers then a success took {_calls(ctx)} calls, expected 3"
    assert ctx.clock.sleeps >= 2, f"the attempts were {ctx.clock.sleeps} sleeps apart: a retry needs a backoff"
    before = _calls(ctx)
    ctx.grpc.fail("BulkWrite", grpc.StatusCode.UNAVAILABLE, "shard down", times=3)
    _fails(m, m.ShardWriteFailed, "with the shard down")
    assert _calls(ctx) - before == 3, f"an outage was tried {_calls(ctx) - before} times, expected MAX_ATTEMPTS = 3"
    before = _calls(ctx)
    ctx.grpc.fail("BulkWrite", grpc.StatusCode.PERMISSION_DENIED, "index is read-only", times=1)
    _fails(m, m.ShardWriteFailed, "with PERMISSION_DENIED")
    assert _calls(ctx) - before == 1, f"PERMISSION_DENIED is not retryable and was tried {_calls(ctx) - before} times, expected 1"


def check_terminal_conflict(ctx):
    m, shard = _client(ctx)
    shard.conflict = "user_id"
    error = _fails(m, m.MappingConflict, "with a mapping conflict on user_id")
    assert getattr(error, "field", None) == "user_id", f"the MappingConflict must carry the field the shard named (user_id), got {getattr(error, 'field', None)!r}"
    assert _calls(ctx) == 1, f"a mapping conflict was sent {_calls(ctx)} times: no retry changes the mapping, it is terminal after one call"
    assert ctx.clock.sleeps == 0, "a mapping conflict must not be slept on and retried"


def check_stable_batch_id(ctx):
    m, shard = _client(ctx)
    shard.lose_reply = 1
    result = m.bulk_write(INDEX, RECORDS)
    calls = ctx.grpc.calls_to("BulkWrite")
    assert len(calls) == 2, f"a write whose reply was lost took {len(calls)} calls, expected 2"
    ids = [c.request.batch_id for c in calls]
    assert ids[0] == ids[1] == result.get("batch_id"), f"the attempts carried batch ids {ids} and the result {result.get('batch_id')}: every attempt of one batch must send the same id"
    assert [c.request.attempt for c in calls] == [1, 2], f"the attempts were numbered {[c.request.attempt for c in calls]}, expected [1, 2]"
    assert shard.documents == 2, f"the shard indexed {shard.documents} documents for a batch of 2 indexable records whose first reply was lost: the retry wrote it again under a new batch id"
    again = m.bulk_write(INDEX, RECORDS)
    assert again.get("batch_id") != result.get("batch_id"), "a new batch must get a new batch id"
`,
    typescript: `const INDEX = 'logs-acme';
const RECORDS = [
  {service: 'checkout', timestamp: '2026-11-03T10:00:00Z', level: 'error', message: 'm-0'},
  {service: 'checkout', timestamp: '2026-11-03T10:00:01Z', level: 'info', message: 'm-1'},
  {service: 'checkout', timestamp: '2026-11-03T10:00:02Z', level: 'trace', message: 'm-2'},
];

/** Indexes each batch id once (a trace record is rejected); conflict refuses every batch, loseReply writes then answers UNAVAILABLE. */
function client(ctx) {
  const pkg = ctx.proto('log_indexer.proto');
  const shard = {batches: new Map(), documents: 0, conflict: '', loseReply: 0};
  ctx.grpc.serve(pkg.logshard.IndexShard.service, {
    BulkWrite(call, callback) {
      const {index, batch_id, records} = call.request;
      if (shard.conflict) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: shard.conflict});
      if (!shard.batches.has(batch_id)) {
        const indexed = records.filter(r => r.level !== 'trace').length;
        shard.documents += indexed;
        shard.batches.set(batch_id, {indexed, rejected: records.length - indexed, index_snapshot: \`\${index}@\${shard.batches.size + 1}\`});
      }
      if (shard.loseReply > 0) {
        shard.loseReply -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset after the write'});
      }
      callback(null, shard.batches.get(batch_id));
    },
  });
  return {m: ctx.load('client'), shard};
}

const calls = (ctx): number => ctx.grpc.callsTo('BulkWrite').length;

async function fails(m, name: string, why: string) {
  let result;
  try {
    result = await m.bulkWrite(INDEX, RECORDS);
  } catch (e) {
    if ((e as Error).constructor.name === name) return e;
    assert.fail(\`\${why}: bulkWrite threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected \${name}\`);
  }
  assert.fail(\`\${why}: bulkWrite returned \${JSON.stringify(result)} instead of throwing \${name}\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const result = await m.bulkWrite(INDEX, RECORDS);
  assert(result.indexed === 2 && result.rejected === 1 && result.index_snapshot === 'logs-acme@1', \`a healthy write must return the shard's reply (indexed 2, rejected 1, snapshot logs-acme@1), got \${JSON.stringify(result)}\`);
  for (const call of ctx.grpc.callsTo('BulkWrite')) {
    assert(call.timeout !== null, 'a BulkWrite carries no deadline: a shard that stops answering holds the batch and its writer for as long as it hangs');
    assert(2.5 <= call.timeout && call.timeout <= 3.5, \`a BulkWrite carries a \${call.timeout} s deadline, expected DEADLINE_MS = 3000\`);
  }
  ctx.grpc.setLatency('BulkWrite', 10.0);
  const before = calls(ctx);
  await fails(m, 'ShardWriteFailed', 'with the shard 10 s slow');
  assert.equal(calls(ctx) - before, 3, \`a shard slower than the deadline was tried \${calls(ctx) - before} times, expected MAX_ATTEMPTS = 3\`);
}

export async function check_retry_set(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('BulkWrite', ctx.grpc.status.UNAVAILABLE, 'shard restarting', 2);
  const result = await m.bulkWrite(INDEX, RECORDS);
  assert.equal(result.indexed, 2, \`two UNAVAILABLE answers are retryable: the third attempt must succeed, got \${JSON.stringify(result)}\`);
  assert.equal(calls(ctx), 3, \`two UNAVAILABLE answers then a success took \${calls(ctx)} calls, expected 3\`);
  assert(ctx.clock.sleeps >= 2, \`the attempts were \${ctx.clock.sleeps} sleeps apart: a retry needs a backoff\`);
  let before = calls(ctx);
  ctx.grpc.fail('BulkWrite', ctx.grpc.status.UNAVAILABLE, 'shard down', 3);
  await fails(m, 'ShardWriteFailed', 'with the shard down');
  assert.equal(calls(ctx) - before, 3, \`an outage was tried \${calls(ctx) - before} times, expected MAX_ATTEMPTS = 3\`);
  before = calls(ctx);
  ctx.grpc.fail('BulkWrite', ctx.grpc.status.PERMISSION_DENIED, 'index is read-only', 1);
  await fails(m, 'ShardWriteFailed', 'with PERMISSION_DENIED');
  assert.equal(calls(ctx) - before, 1, \`PERMISSION_DENIED is not retryable and was tried \${calls(ctx) - before} times, expected 1\`);
}

export async function check_terminal_conflict(ctx) {
  const {m, shard} = client(ctx);
  shard.conflict = 'user_id';
  const error = await fails(m, 'MappingConflict', 'with a mapping conflict on user_id');
  assert.equal(error.field, 'user_id', \`the MappingConflict must carry the field the shard named (user_id), got \${JSON.stringify(error.field)}\`);
  assert.equal(calls(ctx), 1, \`a mapping conflict was sent \${calls(ctx)} times: no retry changes the mapping, it is terminal after one call\`);
  assert.equal(ctx.clock.sleeps, 0, 'a mapping conflict must not be slept on and retried');
}

export async function check_stable_batch_id(ctx) {
  const {m, shard} = client(ctx);
  shard.loseReply = 1;
  const result = await m.bulkWrite(INDEX, RECORDS);
  const made = ctx.grpc.callsTo('BulkWrite');
  assert.equal(made.length, 2, \`a write whose reply was lost took \${made.length} calls, expected 2\`);
  const ids = made.map(c => c.request.batch_id);
  assert(ids[0] === ids[1] && ids[0] === result.batch_id, \`the attempts carried batch ids \${JSON.stringify(ids)} and the result \${result.batch_id}: every attempt of one batch must send the same id\`);
  assert.deepStrictEqual(made.map(c => Number(c.request.attempt)), [1, 2], 'the attempts must be numbered 1 and 2');
  assert.equal(shard.documents, 2, \`the shard indexed \${shard.documents} documents for a batch of 2 indexable records whose first reply was lost: the retry wrote it again under a new batch id\`);
  const again = await m.bulkWrite(INDEX, RECORDS);
  assert.notEqual(again.batch_id, result.batch_id, 'a new batch must get a new batch id');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"logindex/buffer"
	pb "logindex/gen/log_indexer"
	"logindex/shard"

	"leetbuild/harness"
)

const clientIndex = "logs-acme"

var (
	clientBg      = context.Background()
	clientRecords = []buffer.Record{
		{Service: "checkout", Timestamp: "2026-11-03T10:00:00Z", Level: "error", Message: "m-0"},
		{Service: "checkout", Timestamp: "2026-11-03T10:00:01Z", Level: "info", Message: "m-1"},
		{Service: "checkout", Timestamp: "2026-11-03T10:00:02Z", Level: "trace", Message: "m-2"},
	}
)

// shardPeer indexes each batch id once (a trace record is rejected); conflict refuses every batch,
// loseReply writes, then answers Unavailable, that many times.
type shardPeer struct {
	pb.UnimplementedIndexShardServer
	batches   map[string]*pb.BulkWriteReply
	documents int
	conflict  string
	loseReply int
}

func (s *shardPeer) BulkWrite(_ context.Context, req *pb.BulkWriteRequest) (*pb.BulkWriteReply, error) {
	if s.conflict != "" {
		return nil, status.Error(codes.FailedPrecondition, s.conflict)
	}
	if _, seen := s.batches[req.GetBatchId()]; !seen {
		indexed := 0
		for _, r := range req.GetRecords() {
			if r.GetLevel() != "trace" {
				indexed++
			}
		}
		s.documents += indexed
		s.batches[req.GetBatchId()] = &pb.BulkWriteReply{Indexed: int32(indexed), Rejected: int32(len(req.GetRecords()) - indexed), IndexSnapshot: fmt.Sprintf("%s@%d", req.GetIndex(), len(s.batches)+1)}
	}
	if s.loseReply > 0 {
		s.loseReply--
		return nil, status.Error(codes.Unavailable, "connection reset after the write")
	}
	return s.batches[req.GetBatchId()], nil
}

func client(ctx *harness.Ctx) *shardPeer {
	peer := &shardPeer{batches: map[string]*pb.BulkWriteReply{}}
	pb.RegisterIndexShardServer(ctx.GRPC.Server(""), peer)
	return peer
}

func shardCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("BulkWrite", "")) }

func mustWrite(ctx *harness.Ctx, why string) shard.WriteResult {
	result, err := bulkWrite(clientBg, clientIndex, clientRecords)
	ctx.NoError(err, "%s: bulkWrite failed", why)
	return result
}

func writeFails(ctx *harness.Ctx, why string) error {
	result, err := bulkWrite(clientBg, clientIndex, clientRecords)
	ctx.Assert(err != nil, "%s: bulkWrite returned %+v instead of an error", why, result)
	return err
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	result := mustWrite(ctx, "with a healthy shard")
	ctx.Assert(result.Indexed == 2 && result.Rejected == 1 && result.IndexSnapshot == "logs-acme@1", "a healthy write must return the shard's reply (indexed 2, rejected 1, snapshot logs-acme@1), got %+v", result)
	for _, call := range ctx.GRPC.CallsTo("BulkWrite", "") {
		ctx.Assert(call.HasDeadline(), "a BulkWrite carries no deadline: a shard that stops answering holds the batch and its writer for as long as it hangs")
		ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "a BulkWrite carries a %v deadline, expected 3 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("BulkWrite", 10.0, "")
	before := shardCalls(ctx)
	ctx.ErrorIs(writeFails(ctx, "with the shard 10 s slow"), shard.ErrShardWriteFailed, "with the shard 10 s slow")
	ctx.Equal(shardCalls(ctx)-before, 3, "a shard slower than the deadline must be tried maxAttempts = 3 times; the calls")
}

func CheckRetrySet(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("BulkWrite", codes.Unavailable, "shard restarting", 2, "")
	result := mustWrite(ctx, "two Unavailable answers are retryable")
	ctx.Equal(result.Indexed, 2, "after two Unavailable answers the third attempt must succeed; indexed")
	ctx.Equal(shardCalls(ctx), 3, "two Unavailable answers then a success; the calls")
	ctx.Assert(ctx.Clock.Sleeps() >= 2, "the attempts were %d sleeps apart: a retry needs a backoff", ctx.Clock.Sleeps())
	before := shardCalls(ctx)
	ctx.GRPC.Fail("BulkWrite", codes.Unavailable, "shard down", 3, "")
	ctx.ErrorIs(writeFails(ctx, "with the shard down"), shard.ErrShardWriteFailed, "with the shard down")
	ctx.Equal(shardCalls(ctx)-before, 3, "an outage must be tried maxAttempts = 3 times; the calls")
	ctx.GRPC.ClearFailures()
	before = shardCalls(ctx)
	ctx.GRPC.Fail("BulkWrite", codes.PermissionDenied, "index is read-only", 1, "")
	ctx.ErrorIs(writeFails(ctx, "with PermissionDenied"), shard.ErrShardWriteFailed, "with PermissionDenied")
	ctx.Equal(shardCalls(ctx)-before, 1, "PermissionDenied is not retryable; the calls")
}

func CheckTerminalConflict(ctx *harness.Ctx) {
	peer := client(ctx)
	peer.conflict = "user_id"
	err := writeFails(ctx, "with a mapping conflict on user_id")
	var conflict *shard.MappingConflict
	ctx.Assert(errors.As(err, &conflict), "with a mapping conflict bulkWrite must return a *shard.MappingConflict, got %v", err)
	ctx.Equal(conflict.Field, "user_id", "the MappingConflict must carry the field the shard named")
	ctx.Equal(shardCalls(ctx), 1, "no retry changes the mapping, a conflict is terminal after one call; the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a mapping conflict must not be slept on and retried; the sleeps")
}

func CheckStableBatchId(ctx *harness.Ctx) {
	peer := client(ctx)
	peer.loseReply = 1
	result := mustWrite(ctx, "a write whose reply was lost")
	calls := ctx.GRPC.CallsTo("BulkWrite", "")
	ctx.Equal(len(calls), 2, "a write whose reply was lost; the calls")
	first := calls[0].Request.(*pb.BulkWriteRequest)
	second := calls[1].Request.(*pb.BulkWriteRequest)
	ctx.Assert(first.GetBatchId() == second.GetBatchId() && first.GetBatchId() == result.BatchID, "the attempts carried batch ids %q and %q and the result %q: every attempt of one batch must send the same id", first.GetBatchId(), second.GetBatchId(), result.BatchID)
	ctx.Assert(first.GetAttempt() == 1 && second.GetAttempt() == 2, "the attempts were numbered %d and %d, expected 1 and 2", first.GetAttempt(), second.GetAttempt())
	ctx.Equal(peer.documents, 2, "for a batch of 2 indexable records whose first reply was lost the retry wrote it again under a new batch id; the documents indexed")
	again := mustWrite(ctx, "a second batch")
	ctx.Assert(again.BatchID != result.BatchID, "a new batch must get a new batch id")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "log_indexer.grpc.pb.h"
#include "logindex/buffer.h"
#include "logindex/shard.h"

namespace {

const std::string kIndex = "logs-acme";
const std::vector<buffer::Record> kRecords = {
    {"checkout", "2026-11-03T10:00:00Z", "error", "m-0"},
    {"checkout", "2026-11-03T10:00:01Z", "info", "m-1"},
    {"checkout", "2026-11-03T10:00:02Z", "trace", "m-2"},
};

// Indexes each batch id once (a trace record is rejected); conflict refuses every batch, loseReply
// writes, then answers UNAVAILABLE, that many times.
class ShardPeer final : public logshard::IndexShard::Service {
 public:
  std::map<std::string, logshard::BulkWriteReply> batches;
  int documents = 0;
  std::string conflict;
  int loseReply = 0;

  grpc::Status BulkWrite(grpc::ServerContext*, const logshard::BulkWriteRequest* req, logshard::BulkWriteReply* out) override {
    if (!conflict.empty()) return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, conflict);
    if (batches.count(req->batch_id()) == 0) {
      int indexed = 0;
      for (const auto& r : req->records()) indexed += r.level() != "trace";
      documents += indexed;
      logshard::BulkWriteReply reply;
      reply.set_indexed(indexed);
      reply.set_rejected(req->records_size() - indexed);
      reply.set_index_snapshot(req->index() + "@" + std::to_string(batches.size() + 1));
      batches[req->batch_id()] = reply;
    }
    if (loseReply > 0) {
      loseReply--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset after the write");
    }
    *out = batches[req->batch_id()];
    return grpc::Status::OK;
  }
};

ShardPeer& client(harness::Ctx& ctx) {
  static ShardPeer* peer = nullptr;
  delete peer;
  peer = new ShardPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

size_t shardCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("BulkWrite").size(); }

shard::WriteResult mustWrite(harness::Ctx& ctx, const std::string& why) {
  try {
    return ::bulkWrite(kIndex, kRecords);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: bulkWrite threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

template <class E>
E mustThrow(harness::Ctx& ctx, const std::string& expected, const std::string& why) {
  try {
    const shard::WriteResult result = ::bulkWrite(kIndex, kRecords);
    ctx.Fatalf("%s: bulkWrite returned batch %s instead of throwing %s", why, result.batch_id, expected);
  } catch (const E& e) {
    return e;
  } catch (const harness::Failure&) {
    throw;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: bulkWrite threw %s: %s, expected %s", why, harness::CurrentExceptionType(), e.what(), expected);
  }
  throw std::logic_error("unreachable");
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const auto result = mustWrite(ctx, "with a healthy shard");
  ctx.Assert(result.indexed == 2 && result.rejected == 1 && result.index_snapshot == "logs-acme@1",
             "a healthy write must return the shard's reply (indexed 2, rejected 1, snapshot logs-acme@1), got indexed %d, rejected %d, snapshot %q", result.indexed, result.rejected, result.index_snapshot);
  for (const auto& call : ctx.GRPC.CallsTo("BulkWrite")) {
    ctx.Assert(call.HasDeadline(), "a BulkWrite carries no deadline: a shard that stops answering holds the batch and its writer for as long as it hangs");
    ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "a BulkWrite carries a %v s deadline, expected kDeadline = 3 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("BulkWrite", 10.0);
  const size_t before = shardCalls(ctx);
  mustThrow<shard::ShardWriteFailed>(ctx, "ShardWriteFailed", "with the shard 10 s slow");
  ctx.Equal(shardCalls(ctx) - before, 3, "a shard slower than the deadline must be tried kMaxAttempts = 3 times; the calls");
}

void CheckRetrySet(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("BulkWrite", grpc::StatusCode::UNAVAILABLE, "shard restarting", 2);
  const auto result = mustWrite(ctx, "two UNAVAILABLE answers are retryable");
  ctx.Equal(result.indexed, 2, "after two UNAVAILABLE answers the third attempt must succeed; indexed");
  ctx.Equal(shardCalls(ctx), 3, "two UNAVAILABLE answers then a success; the calls");
  ctx.Assert(ctx.Clock.Sleeps() >= 2, "the attempts were %d sleeps apart: a retry needs a backoff", ctx.Clock.Sleeps());
  size_t before = shardCalls(ctx);
  ctx.GRPC.Fail("BulkWrite", grpc::StatusCode::UNAVAILABLE, "shard down", 3);
  mustThrow<shard::ShardWriteFailed>(ctx, "ShardWriteFailed", "with the shard down");
  ctx.Equal(shardCalls(ctx) - before, 3, "an outage must be tried kMaxAttempts = 3 times; the calls");
  ctx.GRPC.ClearFailures();
  before = shardCalls(ctx);
  ctx.GRPC.Fail("BulkWrite", grpc::StatusCode::PERMISSION_DENIED, "index is read-only", 1);
  mustThrow<shard::ShardWriteFailed>(ctx, "ShardWriteFailed", "with PERMISSION_DENIED");
  ctx.Equal(shardCalls(ctx) - before, 1, "PERMISSION_DENIED is not retryable; the calls");
}

void CheckTerminalConflict(harness::Ctx& ctx) {
  ShardPeer& peer = client(ctx);
  peer.conflict = "user_id";
  const auto conflict = mustThrow<shard::MappingConflict>(ctx, "MappingConflict", "with a mapping conflict on user_id");
  ctx.Equal(conflict.field, "user_id", "the MappingConflict must carry the field the shard named");
  ctx.Equal(shardCalls(ctx), 1, "no retry changes the mapping, a conflict is terminal after one call; the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a mapping conflict must not be slept on and retried; the sleeps");
}

void CheckStableBatchId(harness::Ctx& ctx) {
  ShardPeer& peer = client(ctx);
  peer.loseReply = 1;
  const auto result = mustWrite(ctx, "a write whose reply was lost");
  const auto calls = ctx.GRPC.CallsTo("BulkWrite");
  ctx.Equal(calls.size(), 2, "a write whose reply was lost; the calls");
  const auto first = calls[0].Request<logshard::BulkWriteRequest>();
  const auto second = calls[1].Request<logshard::BulkWriteRequest>();
  ctx.Assert(first.batch_id() == second.batch_id() && first.batch_id() == result.batch_id,
             "the attempts carried batch ids %q and %q and the result %q: every attempt of one batch must send the same id", first.batch_id(), second.batch_id(), result.batch_id);
  ctx.Assert(first.attempt() == 1 && second.attempt() == 2, "the attempts were numbered %d and %d, expected 1 and 2", first.attempt(), second.attempt());
  ctx.Equal(peer.documents, 2, "for a batch of 2 indexable records whose first reply was lost the retry wrote it again under a new batch id; the documents indexed");
  const auto again = mustWrite(ctx, "a second batch");
  ctx.Assert(again.batch_id != result.batch_id, "a new batch must get a new batch id");
}
`,
  },
  hints: [
    'Stop the shard from answering: the writer waits as long as it does. Answer UNAVAILABLE five times: it is called five times. Refuse a batch over `user_id`: that is retried too, and a batch whose reply was lost is indexed twice.',
    'The call carries no `timeout`; every `RpcError` goes round the same loop, whatever its code; and the batch id is minted inside the loop, so the shard sees each retry as a new batch.',
    'Mint `batch_id` before `for attempt in range(1, MAX_ATTEMPTS + 1)`; call with `timeout=DEADLINE_S`; on `FAILED_PRECONDITION` raise `MappingConflict(exc.details())`; sleep a backoff and retry only `UNAVAILABLE` and `DEADLINE_EXCEEDED`; otherwise raise `ShardWriteFailed`.',
  ],
  debrief: `The status code tells the client what kind of failure it has: UNAVAILABLE and DEADLINE_EXCEEDED say nothing about the batch and may pass, FAILED_PRECONDITION says the batch itself is wrong and no retry will change that. The deadline turns a hung shard into a DEADLINE_EXCEEDED the loop can count, and the bound turns an outage into a \`ShardWriteFailed\` the writer can act on. The batch id is the idempotency key: minted once, it lets the shard recognise a retry of a write whose reply was lost. A production writer would add jitter to the backoff, share a retry budget across batches so an outage does not multiply the load, and park a conflicting batch in a dead-letter index with the field named.`,
};
