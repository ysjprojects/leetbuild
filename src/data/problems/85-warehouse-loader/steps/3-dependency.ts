import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Warehouse writes that a retry cannot duplicate',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'warehouse'],
  task: `## Task

**Starting point.** The starter is the warehouse client the load worker calls once per partition:
\`write_partition(load, partition_id)\` sends \`WritePartition\` with the load's target, load id,
partition id and SQL to the \`Warehouse\` gRPC service and returns the reply's \`rows_written\`; on any
error it sleeps \`BACKOFF_S × attempt\` and tries again, up to \`MAX_ATTEMPTS\` (3), then raises
\`LoadFailed\`. It loads the demo and hides three flaws.

**Failure mode the checks target.** A warehouse that stops answering holds the worker as long as it
likes; a write whose reply was lost lands twice, so the retried partition is in the table twice; and
a revoked grant is retried, slept on and retried again.

\`\`\`proto
service Warehouse { rpc WritePartition(WriteRequest) returns (WriteReply); }  // merge_key set: MERGE, empty: INSERT
\`\`\`

- Every attempt carries a **\`DEADLINE_S\` = 30 s** deadline.
- Every write sets \`merge_key\` to \`{load_id}/{partition_id}\`: a retry replaces what an earlier
  attempt of the same partition wrote, and another load's partition is left alone.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` (\`RETRYABLE\`) are retried; any other status raises
  \`LoadFailed\` at once, naming the target and the partition.`,
  sequence: {
    participants: ['Load worker', 'Warehouse'],
    messages: [
      {
        from: 'Load worker',
        to: 'Warehouse',
        label: 'WritePartition p-0 · merge_key ld-1/p-0 · deadline 30 s',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Load worker', label: 'UNAVAILABLE (the rows landed, the reply did not)', kind: 'reply'},
      {from: 'Load worker', to: 'Warehouse', label: 'retry · same merge_key replaces the first write', kind: 'sync'},
      {from: 'Warehouse', to: 'Load worker', label: 'rows_written 250', kind: 'reply'},
      {from: 'Load worker', to: 'Warehouse', label: 'WritePartition p-1', kind: 'sync'},
      {from: 'Warehouse', to: 'Load worker', label: 'PERMISSION_DENIED → LoadFailed, no retry', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'writes',
      title: 'Writes a partition and returns the warehouse’s count',
      detail:
        'A healthy write sends the load’s target, load id, partition id and SQL and returns the reply’s `rows_written`.',
      match: {
        python: {all: [/WritePartition\(/, /rows_written/]},
        typescript: {all: [/WritePartition\(/, /rows_written/]},
        go: {all: [/WritePartition\(/, /GetRowsWritten\(\)|\.RowsWritten/]},
        cpp: {all: [/WritePartition\(/, /rows_written\(\)/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 30-second deadline',
      detail:
        'Each `WritePartition` attempt is made with its own `DEADLINE_S` (30 s), not what is left of an earlier attempt’s, and a deadline that passes is retried like `UNAVAILABLE`; the starter calls without one, so a stalled warehouse pins the worker.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*30\b/, /WritePartition\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*30_?000\b/, /WritePartition\([\s\S]{0,160}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*30\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        cpp: {all: [/kDeadline\{30\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'merge-key',
      title: 'A retried partition replaces itself',
      detail:
        'The write carries `merge_key` = `{load_id}/{partition_id}`, so the warehouse merges a retry over the attempt whose reply was lost and keeps other loads’ partitions; the starter sends no key and every attempt is an INSERT.',
      match: {
        python: {all: [/merge_key\s*=/]},
        typescript: {all: [/merge_key:/]},
        go: {all: [/MergeKey:/]},
        cpp: {all: [/set_merge_key\(/]},
      },
    },
    {
      id: 'retry-classification',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        '`RETRYABLE` holds `UNAVAILABLE` and `DEADLINE_EXCEEDED`, both retried; any other status, `PERMISSION_DENIED` first of all but `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION` and `INTERNAL` too, raises `LoadFailed` after one attempt and no sleep. The starter retries every error.',
      match: {
        python: {all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/retryable/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        cpp: {all: [/retryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc

MAX_ATTEMPTS = 3
BACKOFF_S = 0.5

warehouse = warehouse_loader_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


class LoadFailed(Exception):
    """The partition cannot be written: the load stops and the reason is shown to the operator."""


def write_partition(load: dict, partition_id: str) -> int:
    """Write one partition of the load (load_id, target, sql); returns the rows the warehouse wrote."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    request = warehouse_loader_pb2.WriteRequest(
        target=load["target"], load_id=load["load_id"], partition_id=partition_id, sql=load["sql"]
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return warehouse.WritePartition(request).rows_written
        except grpc.RpcError as err:
            if attempt == MAX_ATTEMPTS:
                raise LoadFailed(f"{err.code().name} writing {load['target']} partition {partition_id}: {err.details()}") from err
            time.sleep(BACKOFF_S * attempt)
    raise LoadFailed(f"{load['target']} partition {partition_id}: no attempt left")
`,
      solution: `import time

import grpc

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc

DEADLINE_S = 30
MAX_ATTEMPTS = 3
BACKOFF_S = 0.5
# Statuses that say nothing about the request: the same write may succeed on the next attempt.
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

warehouse = warehouse_loader_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


class LoadFailed(Exception):
    """The partition cannot be written: the load stops and the reason is shown to the operator."""


def write_partition(load: dict, partition_id: str) -> int:
    """Write one partition of the load (load_id, target, sql); returns the rows the warehouse wrote."""
    # The merge key makes a retry replace whatever an earlier attempt of this partition wrote.
    request = warehouse_loader_pb2.WriteRequest(
        target=load["target"],
        load_id=load["load_id"],
        partition_id=partition_id,
        sql=load["sql"],
        merge_key=f"{load['load_id']}/{partition_id}",
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return warehouse.WritePartition(request, timeout=DEADLINE_S).rows_written
        except grpc.RpcError as err:
            if err.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise LoadFailed(f"{err.code().name} writing {load['target']} partition {partition_id}: {err.details()}") from err
            time.sleep(BACKOFF_S * attempt)
    raise LoadFailed(f"{load['target']} partition {partition_id}: no attempt left")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Load} from 'loader/store';

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 500;

interface WriteRequest {
  target: string;
  load_id: string;
  partition_id: string;
  sql: string;
  merge_key?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse_loader.proto')) as unknown as {
  whloader: {Warehouse: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.whloader.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  WritePartition(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows_written: number | string}>;
};

/** The partition cannot be written: the load stops and the reason is shown to the operator. */
export class LoadFailed extends Error {}

/** Write one partition of the load; resolves to the rows the warehouse wrote. */
export async function writePartition(load: Load, partitionId: string): Promise<number> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const request: WriteRequest = {target: load.target, load_id: load.load_id, partition_id: partitionId, sql: load.sql};
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await warehouse.WritePartition(request, new grpc.Metadata(), {});
      return Number(reply.rows_written);
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (attempt >= MAX_ATTEMPTS) throw new LoadFailed(\`\${grpc.status[code]} writing \${load.target} partition \${partitionId}: \${details}\`);
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, BACKOFF_MS * attempt);
      await promise;
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Load} from 'loader/store';

export const DEADLINE_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 500;
/** Statuses that say nothing about the request: the same write may succeed on the next attempt. */
export const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface WriteRequest {
  target: string;
  load_id: string;
  partition_id: string;
  sql: string;
  merge_key?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse_loader.proto')) as unknown as {
  whloader: {Warehouse: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.whloader.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  WritePartition(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows_written: number | string}>;
};

/** The partition cannot be written: the load stops and the reason is shown to the operator. */
export class LoadFailed extends Error {}

/** Write one partition of the load; resolves to the rows the warehouse wrote. */
export async function writePartition(load: Load, partitionId: string): Promise<number> {
  // The merge key makes a retry replace whatever an earlier attempt of this partition wrote.
  const request: WriteRequest = {
    target: load.target,
    load_id: load.load_id,
    partition_id: partitionId,
    sql: load.sql,
    merge_key: \`\${load.load_id}/\${partitionId}\`,
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await warehouse.WritePartition(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return Number(reply.rows_written);
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (!RETRYABLE.includes(code) || attempt >= MAX_ATTEMPTS) {
        throw new LoadFailed(\`\${grpc.status[code]} writing \${load.target} partition \${partitionId}: \${details}\`);
      }
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, BACKOFF_MS * attempt);
      await promise;
    }
  }
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

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "loader/gen/warehouse_loader"
	"loader/store" // store.Load
)

const (
	maxAttempts = 3
	backoff     = 500 * time.Millisecond
)

var (
	warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	warehouse        = pb.NewWarehouseClient(warehouseConn)
)

// ErrLoadFailed: the partition cannot be written; the load stops and the reason is shown to the operator.
var ErrLoadFailed = errors.New("load failed")

// writePartition writes one partition of the load and returns the rows the warehouse wrote.
func writePartition(ctx context.Context, load store.Load, partitionID string) (int64, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	request := &pb.WriteRequest{Target: load.Target, LoadId: load.LoadID, PartitionId: partitionID, Sql: load.SQL}
	for attempt := 1; ; attempt++ {
		reply, err := warehouse.WritePartition(ctx, request)
		if err == nil {
			return reply.GetRowsWritten(), nil
		}
		if attempt >= maxAttempts {
			return 0, fmt.Errorf("%w: %v writing %s partition %s: %s", ErrLoadFailed, status.Code(err), load.Target, partitionID, status.Convert(err).Message())
		}
		time.Sleep(backoff * time.Duration(attempt))
	}
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

	pb "loader/gen/warehouse_loader"
	"loader/store" // store.Load
)

const (
	deadline    = 30 * time.Second
	maxAttempts = 3
	backoff     = 500 * time.Millisecond
)

// retryable statuses say nothing about the request: the same write may succeed on the next attempt.
var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	warehouse        = pb.NewWarehouseClient(warehouseConn)
)

// ErrLoadFailed: the partition cannot be written; the load stops and the reason is shown to the operator.
var ErrLoadFailed = errors.New("load failed")

// writePartition writes one partition of the load and returns the rows the warehouse wrote.
func writePartition(ctx context.Context, load store.Load, partitionID string) (int64, error) {
	// The merge key makes a retry replace whatever an earlier attempt of this partition wrote.
	request := &pb.WriteRequest{Target: load.Target, LoadId: load.LoadID, PartitionId: partitionID, Sql: load.SQL, MergeKey: load.LoadID + "/" + partitionID}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := warehouse.WritePartition(callCtx, request)
		cancel()
		if err == nil {
			return reply.GetRowsWritten(), nil
		}
		if !retryable[status.Code(err)] || attempt >= maxAttempts {
			return 0, fmt.Errorf("%w: %v writing %s partition %s: %s", ErrLoadFailed, status.Code(err), load.Target, partitionID, status.Convert(err).Message())
		}
		time.Sleep(backoff * time.Duration(attempt))
	}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "loader/store.h"  // store::Load
#include "warehouse_loader.grpc.pb.h"

constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{500};

auto warehouse = whloader::Warehouse::NewStub(grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials()));

// The partition cannot be written: the load stops and the reason is shown to the operator.
struct LoadFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Write one partition of the load; returns the rows the warehouse wrote.
long writePartition(const store::Load& load, const std::string& partition_id) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  whloader::WriteRequest request;
  request.set_target(load.target);
  request.set_load_id(load.load_id);
  request.set_partition_id(partition_id);
  request.set_sql(load.sql);
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    whloader::WriteReply reply;
    const grpc::Status status = warehouse->WritePartition(&ctx, request, &reply);
    if (status.ok()) return reply.rows_written();
    if (attempt >= kMaxAttempts) throw LoadFailed("writing " + load.target + " partition " + partition_id + ": " + status.error_message());
    std::this_thread::sleep_for(kBackoff * attempt);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "loader/store.h"  // store::Load
#include "warehouse_loader.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{30};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{500};

auto warehouse = whloader::Warehouse::NewStub(grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials()));

// The partition cannot be written: the load stops and the reason is shown to the operator.
struct LoadFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Write one partition of the load; returns the rows the warehouse wrote.
long writePartition(const store::Load& load, const std::string& partition_id) {
  whloader::WriteRequest request;
  request.set_target(load.target);
  request.set_load_id(load.load_id);
  request.set_partition_id(partition_id);
  request.set_sql(load.sql);
  // The merge key makes a retry replace whatever an earlier attempt of this partition wrote.
  request.set_merge_key(load.load_id + "/" + partition_id);
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    whloader::WriteReply reply;
    const grpc::Status status = warehouse->WritePartition(&ctx, request, &reply);
    if (status.ok()) return reply.rows_written();
    // UNAVAILABLE and DEADLINE_EXCEEDED say nothing about the request: the same write may succeed next time.
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt >= kMaxAttempts) {
      throw LoadFailed("writing " + load.target + " partition " + partition_id + ": " + status.error_message());
    }
    std::this_thread::sleep_for(kBackoff * attempt);
  }
}
`,
    },
  },
  harness: {
    python: `import grpc

import warehouse_loader_pb2
import warehouse_loader_pb2_grpc

ROWS = {"p-0": 250, "p-1": 240, "p-2": 260}
LOAD = {
    "load_id": "ld-1", "tenant": "acme", "dataset": "orders", "version": "2026-10-20", "target": "wh_acme.orders", "mode": "merge",
    "transform": "dedupe", "sql": "SELECT DISTINCT * FROM source", "partitions": 3, "rows_planned": 750, "rows_read": 750, "status": "loading",
}
NEXT = {**LOAD, "load_id": "ld-2", "version": "2026-10-21"}


class Warehouse(warehouse_loader_pb2_grpc.WarehouseServicer):
    """One table per target. An INSERT adds the partition's rows; a MERGE first drops the rows its merge key wrote before. While lose_reply > 0 a write lands and its reply is lost (UNAVAILABLE)."""

    def __init__(self):
        self.rows = []  # (target, load_id, merge_key, rows)
        self.lose_reply = 0

    def WritePartition(self, request, context):
        if request.merge_key:
            self.rows = [r for r in self.rows if not (r[0] == request.target and r[2] == request.merge_key)]
        rows = ROWS.get(request.partition_id, 100)
        self.rows.append((request.target, request.load_id, request.merge_key, rows))
        if self.lose_reply > 0:
            self.lose_reply -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset before the reply")
        return warehouse_loader_pb2.WriteReply(rows_written=rows)

    def held(self, target, load_id):
        return sum(r[3] for r in self.rows if r[0] == target and r[1] == load_id)


def _client(ctx):
    warehouse = Warehouse()
    ctx.grpc.serve(warehouse_loader_pb2_grpc.add_WarehouseServicer_to_server, warehouse)
    return ctx.load("client"), warehouse


def _fails(m, load, partition_id, why):
    try:
        written = m.write_partition(load, partition_id)
    except m.LoadFailed as exc:
        return str(exc)
    except Exception as other:
        raise AssertionError(f"{why}: write_partition raised {type(other).__name__}: {other}, expected LoadFailed")
    raise AssertionError(f"{why}: write_partition returned {written} instead of raising LoadFailed")


def check_writes(ctx):
    m, warehouse = _client(ctx)
    assert m.write_partition(LOAD, "p-0") == 250, "write_partition must return the rows_written the warehouse answered (250 for p-0)"
    assert m.write_partition(LOAD, "p-1") == 240, "write_partition must return the rows_written the warehouse answered (240 for p-1)"
    assert warehouse.held("wh_acme.orders", "ld-1") == 490, f"wh_acme.orders holds {warehouse.held('wh_acme.orders', 'ld-1')} rows of ld-1, expected 490"
    request = ctx.grpc.calls_to("WritePartition")[0].request
    sent = (request.target, request.load_id, request.partition_id, request.sql)
    assert sent == ("wh_acme.orders", "ld-1", "p-0", LOAD["sql"]), f"the write must carry the load's target, load id, partition id and SQL, it carried {sent}"


def check_deadline(ctx):
    m, _ = _client(ctx)
    m.write_partition(LOAD, "p-0")
    for call in ctx.grpc.calls_to("WritePartition"):
        assert call.timeout is not None, "a WritePartition call carries no deadline: a stalled warehouse would hold the worker forever"
        assert 29.5 <= call.timeout <= 30.5, f"a WritePartition call carries a {call.timeout} s deadline, expected DEADLINE_S = 30"
    ctx.grpc.set_latency("WritePartition", 45.0)
    before = len(ctx.grpc.calls_to("WritePartition"))
    _fails(m, LOAD, "p-1", "with the warehouse slower than the deadline on every attempt")
    attempts = len(ctx.grpc.calls_to("WritePartition")) - before
    assert attempts == 3, f"a passed deadline is retryable: expected MAX_ATTEMPTS (3) attempts, got {attempts}"
    for n, call in enumerate(ctx.grpc.calls_to("WritePartition")[before:], start=1):
        assert call.timeout is not None and 29.5 <= call.timeout <= 30.5, f"attempt {n} after a deadline that passed carries a {call.timeout} s deadline: every attempt gets its own DEADLINE_S = 30, not what is left of the first one's"


def check_merge_key(ctx):
    m, warehouse = _client(ctx)
    warehouse.lose_reply = 1
    written = m.write_partition(LOAD, "p-0")
    assert len(ctx.grpc.calls_to("WritePartition")) == 2, "a write whose reply was lost must be retried once"
    assert written == 250, f"the retried write must return the warehouse's 250, got {written}"
    held = warehouse.held("wh_acme.orders", "ld-1")
    assert held == 250, f"after one retried write wh_acme.orders holds {held} rows of ld-1's p-0, expected 250: the retry inserted the partition a second time. Set merge_key so the warehouse merges it"
    m.write_partition(NEXT, "p-0")
    assert warehouse.held("wh_acme.orders", "ld-1") == 250, "ld-2's p-0 replaced ld-1's p-0: the merge key is the load and the partition, {load_id}/{partition_id}"
    assert warehouse.held("wh_acme.orders", "ld-2") == 250, f"ld-2's p-0 must hold 250 rows, holds {warehouse.held('wh_acme.orders', 'ld-2')}"
    keys = [call.request.merge_key for call in ctx.grpc.calls_to("WritePartition")[:2]]
    assert keys == ["ld-1/p-0", "ld-1/p-0"], f"both attempts of ld-1's p-0 must carry merge_key 'ld-1/p-0' ({{load_id}}/{{partition_id}}), they carried {keys}"


def check_retry_classification(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("WritePartition", grpc.StatusCode.PERMISSION_DENIED, "loaderd may not write wh_acme.orders", times=1)
    reason = _fails(m, LOAD, "p-0", "with the loader's grant on wh_acme.orders revoked")
    calls = len(ctx.grpc.calls_to("WritePartition"))
    assert calls == 1, f"PERMISSION_DENIED was sent {calls} times: it cannot succeed on a retry, it stops the load"
    assert ctx.clock.sleeps == 0, "PERMISSION_DENIED must not be slept on"
    assert "wh_acme.orders" in reason and "p-0" in reason, f"LoadFailed must name the target and the partition, it says {reason!r}"
    for code in (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.NOT_FOUND, grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INTERNAL):
        before = len(ctx.grpc.calls_to("WritePartition"))
        ctx.grpc.fail("WritePartition", code, f"the warehouse answered {code.name}", times=1)
        _fails(m, LOAD, "p-0", f"with the warehouse answering {code.name}")
        calls = len(ctx.grpc.calls_to("WritePartition")) - before
        assert calls == 1, f"{code.name} was sent {calls} times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, every other status stops the load"
    assert ctx.clock.sleeps == 0, f"a status that is not retried must not be slept on, the worker slept {ctx.clock.sleeps} times"
    ctx.grpc.fail("WritePartition", grpc.StatusCode.DEADLINE_EXCEEDED, times=2)
    assert m.write_partition(LOAD, "p-2") == 260, "DEADLINE_EXCEEDED is retryable: after two failures the third attempt must write p-2"
    ctx.grpc.fail("WritePartition", grpc.StatusCode.UNAVAILABLE, times=2)
    assert m.write_partition(LOAD, "p-1") == 240, "UNAVAILABLE is retryable: after two failures the third attempt must write p-1"
`,
    typescript: `const ROWS: Record<string, number> = {'p-0': 250, 'p-1': 240, 'p-2': 260};
const LOAD = {
  load_id: 'ld-1', tenant: 'acme', dataset: 'orders', version: '2026-10-20', target: 'wh_acme.orders', mode: 'merge',
  transform: 'dedupe', sql: 'SELECT DISTINCT * FROM source', partitions: 3, rows_planned: 750, rows_read: 750, status: 'loading',
};
const NEXT = {...LOAD, load_id: 'ld-2', version: '2026-10-21'};

/** One table per target: an INSERT adds the partition's rows, a MERGE first drops what its merge key wrote. While loseReply > 0 a write lands and its reply is lost. */
function client(ctx) {
  const pkg = ctx.proto('warehouse_loader.proto');
  const warehouse = {rows: [] as {target: string; load_id: string; merge_key: string; rows: number}[], loseReply: 0};
  ctx.grpc.serve(pkg.whloader.Warehouse.service, {
    WritePartition(call, callback) {
      const {target, load_id, partition_id, merge_key} = call.request;
      if (merge_key) warehouse.rows = warehouse.rows.filter(r => !(r.target === target && r.merge_key === merge_key));
      const rows = ROWS[partition_id] ?? 100;
      warehouse.rows.push({target, load_id, merge_key, rows});
      if (warehouse.loseReply > 0) {
        warehouse.loseReply -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset before the reply'});
      }
      callback(null, {rows_written: rows});
    },
  });
  const held = (target: string, loadId: string): number =>
    warehouse.rows.filter(r => r.target === target && r.load_id === loadId).reduce((sum, r) => sum + r.rows, 0);
  return {m: ctx.load('client'), warehouse, held};
}

async function fails(m, load, partitionId: string, why: string): Promise<string> {
  let written;
  try {
    written = await m.writePartition(load, partitionId);
  } catch (e) {
    if (e instanceof m.LoadFailed) return (e as Error).message;
    assert.fail(\`\${why}: writePartition threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected LoadFailed\`);
  }
  assert.fail(\`\${why}: writePartition returned \${written} instead of throwing LoadFailed\`);
}

export async function check_writes(ctx) {
  const {m, held} = client(ctx);
  assert.equal(await m.writePartition(LOAD, 'p-0'), 250, 'writePartition must resolve to the rows_written the warehouse answered (250 for p-0)');
  assert.equal(await m.writePartition(LOAD, 'p-1'), 240, 'writePartition must resolve to the rows_written the warehouse answered (240 for p-1)');
  assert.equal(held('wh_acme.orders', 'ld-1'), 490, \`wh_acme.orders holds \${held('wh_acme.orders', 'ld-1')} rows of ld-1, expected 490\`);
  const {target, load_id, partition_id, sql} = ctx.grpc.callsTo('WritePartition')[0].request;
  assert.deepEqual([target, load_id, partition_id, sql], ['wh_acme.orders', 'ld-1', 'p-0', LOAD.sql], 'the write must carry the load\\'s target, load id, partition id and SQL');
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  await m.writePartition(LOAD, 'p-0');
  for (const call of ctx.grpc.callsTo('WritePartition')) {
    assert(call.timeout !== null, 'a WritePartition call carries no deadline: a stalled warehouse would hold the worker forever');
    assert(29.5 <= call.timeout && call.timeout <= 30.5, \`a WritePartition call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 30000\`);
  }
  ctx.grpc.setLatency('WritePartition', 45.0);
  const before = ctx.grpc.callsTo('WritePartition').length;
  await fails(m, LOAD, 'p-1', 'with the warehouse slower than the deadline on every attempt');
  const attempts = ctx.grpc.callsTo('WritePartition').length - before;
  assert.equal(attempts, 3, \`a passed deadline is retryable: expected MAX_ATTEMPTS (3) attempts, got \${attempts}\`);
  ctx.grpc.callsTo('WritePartition').slice(before).forEach((call, i) => {
    assert(call.timeout !== null && 29.5 <= call.timeout && call.timeout <= 30.5, \`attempt \${i + 1} after a deadline that passed carries a \${call.timeout} s deadline: every attempt gets its own DEADLINE_MS = 30000, not what is left of the first one's\`);
  });
}

export async function check_merge_key(ctx) {
  const {m, warehouse, held} = client(ctx);
  warehouse.loseReply = 1;
  const written = await m.writePartition(LOAD, 'p-0');
  assert.equal(ctx.grpc.callsTo('WritePartition').length, 2, 'a write whose reply was lost must be retried once');
  assert.equal(written, 250, \`the retried write must resolve to the warehouse's 250, got \${written}\`);
  const rows = held('wh_acme.orders', 'ld-1');
  assert.equal(rows, 250, \`after one retried write wh_acme.orders holds \${rows} rows of ld-1's p-0, expected 250: the retry inserted the partition a second time. Set merge_key so the warehouse merges it\`);
  await m.writePartition(NEXT, 'p-0');
  assert.equal(held('wh_acme.orders', 'ld-1'), 250, "ld-2's p-0 replaced ld-1's p-0: the merge key is the load and the partition, {load_id}/{partition_id}");
  assert.equal(held('wh_acme.orders', 'ld-2'), 250, "ld-2's p-0 must hold 250 rows");
  const keys = ctx.grpc.callsTo('WritePartition').slice(0, 2).map(call => call.request.merge_key);
  assert.deepEqual(keys, ['ld-1/p-0', 'ld-1/p-0'], \`both attempts of ld-1's p-0 must carry merge_key 'ld-1/p-0' ({load_id}/{partition_id}), they carried \${JSON.stringify(keys)}\`);
}

export async function check_retry_classification(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('WritePartition', ctx.grpc.status.PERMISSION_DENIED, 'loaderd may not write wh_acme.orders', 1);
  const reason = await fails(m, LOAD, 'p-0', "with the loader's grant on wh_acme.orders revoked");
  const calls = ctx.grpc.callsTo('WritePartition').length;
  assert.equal(calls, 1, \`PERMISSION_DENIED was sent \${calls} times: it cannot succeed on a retry, it stops the load\`);
  assert.equal(ctx.clock.sleeps, 0, 'PERMISSION_DENIED must not be slept on');
  assert(reason.includes('wh_acme.orders') && reason.includes('p-0'), \`LoadFailed must name the target and the partition, it says \${JSON.stringify(reason)}\`);
  for (const name of ['INVALID_ARGUMENT', 'NOT_FOUND', 'FAILED_PRECONDITION', 'INTERNAL']) {
    const before = ctx.grpc.callsTo('WritePartition').length;
    ctx.grpc.fail('WritePartition', ctx.grpc.status[name], \`the warehouse answered \${name}\`, 1);
    await fails(m, LOAD, 'p-0', \`with the warehouse answering \${name}\`);
    const sent = ctx.grpc.callsTo('WritePartition').length - before;
    assert.equal(sent, 1, \`\${name} was sent \${sent} times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, every other status stops the load\`);
  }
  assert.equal(ctx.clock.sleeps, 0, 'a status that is not retried must not be slept on');
  ctx.grpc.fail('WritePartition', ctx.grpc.status.DEADLINE_EXCEEDED, '', 2);
  assert.equal(await m.writePartition(LOAD, 'p-2'), 260, 'DEADLINE_EXCEEDED is retryable: after two failures the third attempt must write p-2');
  ctx.grpc.fail('WritePartition', ctx.grpc.status.UNAVAILABLE, '', 2);
  assert.equal(await m.writePartition(LOAD, 'p-1'), 240, 'UNAVAILABLE is retryable: after two failures the third attempt must write p-1');
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "loader/gen/warehouse_loader"
	"loader/store"

	"leetbuild/harness"
)

var (
	hClientBg   = context.Background()
	hClientRows = map[string]int64{"p-0": 250, "p-1": 240, "p-2": 260}
	hClientLoad = store.Load{LoadID: "ld-1", Tenant: "acme", Dataset: "orders", Version: "2026-10-20", Target: "wh_acme.orders", Mode: "merge",
		Transform: "dedupe", SQL: "SELECT DISTINCT * FROM source", Partitions: 3, RowsPlanned: 750, RowsRead: 750, Status: "loading"}
)

type HClientRow struct {
	target, loadID, mergeKey string
	rows                     int64
}

// warehousePeer has one table per target: an INSERT adds the partition's rows, a MERGE first drops
// what its merge key wrote. While loseReply > 0 a write lands and its reply is lost (UNAVAILABLE).
type HWarehousePeer struct {
	pb.UnimplementedWarehouseServer
	rows      []HClientRow
	loseReply int
}

func (w *HWarehousePeer) WritePartition(_ context.Context, req *pb.WriteRequest) (*pb.WriteReply, error) {
	if req.GetMergeKey() != "" {
		kept := w.rows[:0]
		for _, r := range w.rows {
			if !(r.target == req.GetTarget() && r.mergeKey == req.GetMergeKey()) {
				kept = append(kept, r)
			}
		}
		w.rows = kept
	}
	rows, ok := hClientRows[req.GetPartitionId()]
	if !ok {
		rows = 100
	}
	w.rows = append(w.rows, HClientRow{req.GetTarget(), req.GetLoadId(), req.GetMergeKey(), rows})
	if w.loseReply > 0 {
		w.loseReply--
		return nil, status.Error(codes.Unavailable, "connection reset before the reply")
	}
	return &pb.WriteReply{RowsWritten: rows}, nil
}

func (w *HWarehousePeer) held(target, loadID string) int64 {
	var sum int64
	for _, r := range w.rows {
		if r.target == target && r.loadID == loadID {
			sum += r.rows
		}
	}
	return sum
}

func hHlServeWarehouse(ctx *harness.Ctx) *HWarehousePeer {
	peer := &HWarehousePeer{}
	pb.RegisterWarehouseServer(ctx.GRPC.Server(""), peer)
	return peer
}

func hClientWrite(ctx *harness.Ctx, load store.Load, partitionID string) int64 {
	written, err := writePartition(hClientBg, load, partitionID)
	ctx.NoError(err, "writePartition(%s, %s) failed", load.LoadID, partitionID)
	return written
}

func hClientFails(ctx *harness.Ctx, load store.Load, partitionID, why string) string {
	written, err := writePartition(hClientBg, load, partitionID)
	ctx.Assert(err != nil, "%s: writePartition returned %d instead of an error wrapping ErrLoadFailed", why, written)
	ctx.ErrorIs(err, ErrLoadFailed, "%s: writePartition returned %v", why, err)
	return err.Error()
}

func CheckWrites(ctx *harness.Ctx) {
	peer := hHlServeWarehouse(ctx)
	ctx.Equal(hClientWrite(ctx, hClientLoad, "p-0"), 250, "writePartition must return the rows_written the warehouse answered for p-0")
	ctx.Equal(hClientWrite(ctx, hClientLoad, "p-1"), 240, "writePartition must return the rows_written the warehouse answered for p-1")
	ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 490, "the rows of ld-1 in wh_acme.orders")
	req := ctx.GRPC.CallsTo("WritePartition", "")[0].Request.(*pb.WriteRequest)
	ctx.Equal([]string{req.GetTarget(), req.GetLoadId(), req.GetPartitionId(), req.GetSql()}, []string{"wh_acme.orders", "ld-1", "p-0", hClientLoad.SQL}, "the write must carry the load's target, load id, partition id and SQL")
}

func CheckDeadline(ctx *harness.Ctx) {
	hHlServeWarehouse(ctx)
	hClientWrite(ctx, hClientLoad, "p-0")
	for _, call := range ctx.GRPC.CallsTo("WritePartition", "") {
		ctx.Assert(call.HasDeadline(), "a WritePartition call carries no deadline: a stalled warehouse would hold the worker forever")
		ctx.Assert(29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "a WritePartition call carries a %v deadline, expected 30 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("WritePartition", 45.0, "")
	before := len(ctx.GRPC.CallsTo("WritePartition", ""))
	hClientFails(ctx, hClientLoad, "p-1", "with the warehouse slower than the deadline on every attempt")
	ctx.Equal(len(ctx.GRPC.CallsTo("WritePartition", ""))-before, 3, "a passed deadline is retryable: the attempts (maxAttempts)")
	for i, call := range ctx.GRPC.CallsTo("WritePartition", "")[before:] {
		ctx.Assert(call.HasDeadline() && 29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "attempt %d after a deadline that passed carries a %v deadline: every attempt gets its own 30 s, not what is left of the first one's", i+1, call.Timeout)
	}
}

func CheckMergeKey(ctx *harness.Ctx) {
	peer := hHlServeWarehouse(ctx)
	peer.loseReply = 1
	written := hClientWrite(ctx, hClientLoad, "p-0")
	ctx.Equal(len(ctx.GRPC.CallsTo("WritePartition", "")), 2, "a write whose reply was lost must be retried once; the attempts")
	ctx.Equal(written, 250, "the retried write must return the warehouse's count")
	ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 250, "after one retried write the retry inserted the partition a second time: set MergeKey so the warehouse merges it; the rows of ld-1's p-0")
	next := hClientLoad
	next.LoadID = "ld-2"
	next.Version = "2026-10-21"
	hClientWrite(ctx, next, "p-0")
	ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 250, "ld-2's p-0 must not replace ld-1's p-0 (the merge key is {load_id}/{partition_id}); the rows of ld-1")
	ctx.Equal(peer.held("wh_acme.orders", "ld-2"), 250, "the rows of ld-2's p-0")
	for i, call := range ctx.GRPC.CallsTo("WritePartition", "")[:2] {
		ctx.Equal(call.Request.(*pb.WriteRequest).GetMergeKey(), "ld-1/p-0", "attempt %d of ld-1's p-0: the merge key is {load_id}/{partition_id}; its MergeKey", i+1)
	}
}

func CheckRetryClassification(ctx *harness.Ctx) {
	hHlServeWarehouse(ctx)
	ctx.GRPC.Fail("WritePartition", codes.PermissionDenied, "loaderd may not write wh_acme.orders", 1, "")
	reason := hClientFails(ctx, hClientLoad, "p-0", "with the loader's grant on wh_acme.orders revoked")
	ctx.Equal(len(ctx.GRPC.CallsTo("WritePartition", "")), 1, "PERMISSION_DENIED cannot succeed on a retry, it stops the load; the attempts")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "PERMISSION_DENIED must not be slept on; the sleeps")
	ctx.Assert(strings.Contains(reason, "wh_acme.orders") && strings.Contains(reason, "p-0"), "the error must name the target and the partition, it says %q", reason)
	for _, code := range []codes.Code{codes.InvalidArgument, codes.NotFound, codes.FailedPrecondition, codes.Internal} {
		before := len(ctx.GRPC.CallsTo("WritePartition", ""))
		ctx.GRPC.Fail("WritePartition", code, "the warehouse answered "+code.String(), 1, "")
		hClientFails(ctx, hClientLoad, "p-0", "with the warehouse answering "+code.String())
		ctx.Equal(len(ctx.GRPC.CallsTo("WritePartition", ""))-before, 1, "only Unavailable and DeadlineExceeded are retried, every other status stops the load: the attempts with %v", code)
	}
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a status that is not retried must not be slept on; the sleeps")
	ctx.GRPC.Fail("WritePartition", codes.DeadlineExceeded, "", 2, "")
	ctx.Equal(hClientWrite(ctx, hClientLoad, "p-2"), 260, "DeadlineExceeded is retryable: after two failures the third attempt must write p-2")
	ctx.GRPC.Fail("WritePartition", codes.Unavailable, "", 2, "")
	ctx.Equal(hClientWrite(ctx, hClientLoad, "p-1"), 240, "UNAVAILABLE is retryable: after two failures the third attempt must write p-1")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <utility>
#include <vector>

#include "loader/store.h"

namespace {

const std::map<std::string, long> kHRows = {{"p-0", 250}, {"p-1", 240}, {"p-2", 260}};
const store::Load kHLoad{"ld-1", "acme", "orders", "2026-10-20", "wh_acme.orders", "merge", "dedupe", "SELECT DISTINCT * FROM source", 3, 750, 750, "loading"};

struct HHlRow {
  std::string target, load_id, merge_key;
  long rows;
};

// One table per target: an INSERT adds the partition's rows, a MERGE first drops what its merge key
// wrote. While lose_reply > 0 a write lands and its reply is lost (UNAVAILABLE).
class HWarehousePeer final : public whloader::Warehouse::Service {
 public:
  std::vector<HHlRow> rows;
  int lose_reply = 0;

  grpc::Status WritePartition(grpc::ServerContext*, const whloader::WriteRequest* req, whloader::WriteReply* out) override {
    if (!req->merge_key().empty()) {
      std::vector<HHlRow> kept;
      for (const HHlRow& r : rows) {
        if (!(r.target == req->target() && r.merge_key == req->merge_key())) kept.push_back(r);
      }
      rows = kept;
    }
    const auto known = kHRows.find(req->partition_id());
    const long n = known == kHRows.end() ? 100 : known->second;
    rows.push_back(HHlRow{req->target(), req->load_id(), req->merge_key(), n});
    if (lose_reply > 0) {
      lose_reply--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset before the reply");
    }
    out->set_rows_written(n);
    return grpc::Status::OK;
  }

  long held(const std::string& target, const std::string& load_id) const {
    long sum = 0;
    for (const HHlRow& r : rows) {
      if (r.target == target && r.load_id == load_id) sum += r.rows;
    }
    return sum;
  }
};

HWarehousePeer& hHlServeWarehouse(harness::Ctx& ctx) {
  static HWarehousePeer* peer = nullptr;
  delete peer;
  peer = new HWarehousePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

long hHlMustWrite(harness::Ctx& ctx, const store::Load& load, const std::string& partition_id) {
  try {
    return writePartition(load, partition_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("writePartition(%s, %s) threw %s: %s", load.load_id, partition_id, harness::CurrentExceptionType(), e.what());
  }
  return 0;
}

std::string hHlMustFail(harness::Ctx& ctx, const store::Load& load, const std::string& partition_id, const std::string& why) {
  long written = 0;
  try {
    written = writePartition(load, partition_id);
  } catch (const LoadFailed& e) {
    return e.what();
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: writePartition threw %s: %s, expected LoadFailed", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Fatalf("%s: writePartition returned %d instead of throwing LoadFailed", why, written);
  return "";
}

}  // namespace

void CheckWrites(harness::Ctx& ctx) {
  HWarehousePeer& peer = hHlServeWarehouse(ctx);
  ctx.Equal(hHlMustWrite(ctx, kHLoad, "p-0"), 250, "writePartition must return the rows_written the warehouse answered for p-0");
  ctx.Equal(hHlMustWrite(ctx, kHLoad, "p-1"), 240, "writePartition must return the rows_written the warehouse answered for p-1");
  ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 490, "the rows of ld-1 in wh_acme.orders");
  const auto& req = ctx.GRPC.CallsTo("WritePartition")[0].Request<whloader::WriteRequest>();
  ctx.Equal(std::vector<std::string>{req.target(), req.load_id(), req.partition_id(), req.sql()}, std::vector<std::string>{"wh_acme.orders", "ld-1", "p-0", kHLoad.sql},
            "the write must carry the load's target, load id, partition id and SQL");
}

void CheckDeadline(harness::Ctx& ctx) {
  hHlServeWarehouse(ctx);
  hHlMustWrite(ctx, kHLoad, "p-0");
  for (const auto& call : ctx.GRPC.CallsTo("WritePartition")) {
    ctx.Assert(call.HasDeadline(), "a WritePartition call carries no deadline: a stalled warehouse would hold the worker forever");
    ctx.Assert(29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5, "a WritePartition call carries a %v s deadline, expected kDeadline = 30 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("WritePartition", 45.0);
  const size_t before = ctx.GRPC.CallsTo("WritePartition").size();
  hHlMustFail(ctx, kHLoad, "p-1", "with the warehouse slower than the deadline on every attempt");
  ctx.Equal(ctx.GRPC.CallsTo("WritePartition").size() - before, 3, "a passed deadline is retryable: the attempts (kMaxAttempts)");
  const auto calls = ctx.GRPC.CallsTo("WritePartition");
  for (size_t i = before; i < calls.size(); i++) {
    ctx.Assert(calls[i].HasDeadline() && 29.5 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 30.5, "attempt %d after a deadline that passed carries a %v s deadline: every attempt gets its own kDeadline = 30 s, not what is left of the first one's", int(i - before + 1), calls[i].TimeoutSeconds());
  }
}

void CheckMergeKey(harness::Ctx& ctx) {
  HWarehousePeer& peer = hHlServeWarehouse(ctx);
  peer.lose_reply = 1;
  const long written = hHlMustWrite(ctx, kHLoad, "p-0");
  ctx.Equal(ctx.GRPC.CallsTo("WritePartition").size(), 2, "a write whose reply was lost must be retried once; the attempts");
  ctx.Equal(written, 250, "the retried write must return the warehouse's count");
  ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 250, "after one retried write the retry inserted the partition a second time: set merge_key so the warehouse merges it; the rows of ld-1's p-0");
  store::Load next = kHLoad;
  next.load_id = "ld-2";
  next.version = "2026-10-21";
  hHlMustWrite(ctx, next, "p-0");
  ctx.Equal(peer.held("wh_acme.orders", "ld-1"), 250, "ld-2's p-0 must not replace ld-1's p-0 (the merge key is {load_id}/{partition_id}); the rows of ld-1");
  ctx.Equal(peer.held("wh_acme.orders", "ld-2"), 250, "the rows of ld-2's p-0");
  const auto attempts = ctx.GRPC.CallsTo("WritePartition");
  for (size_t i = 0; i < 2 && i < attempts.size(); i++) {
    ctx.Equal(attempts[i].Request<whloader::WriteRequest>().merge_key(), "ld-1/p-0", "every attempt of ld-1's p-0 carries the merge key {load_id}/{partition_id}; its merge_key");
  }
}

void CheckRetryClassification(harness::Ctx& ctx) {
  hHlServeWarehouse(ctx);
  ctx.GRPC.Fail("WritePartition", grpc::StatusCode::PERMISSION_DENIED, "loaderd may not write wh_acme.orders", 1);
  const std::string reason = hHlMustFail(ctx, kHLoad, "p-0", "with the loader's grant on wh_acme.orders revoked");
  ctx.Equal(ctx.GRPC.CallsTo("WritePartition").size(), 1, "PERMISSION_DENIED cannot succeed on a retry, it stops the load; the attempts");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "PERMISSION_DENIED must not be slept on; the sleeps");
  ctx.Assert(reason.find("wh_acme.orders") != std::string::npos && reason.find("p-0") != std::string::npos, "LoadFailed must name the target and the partition, it says %q", reason);
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal = {
      {grpc::StatusCode::INVALID_ARGUMENT, "INVALID_ARGUMENT"},
      {grpc::StatusCode::NOT_FOUND, "NOT_FOUND"},
      {grpc::StatusCode::FAILED_PRECONDITION, "FAILED_PRECONDITION"},
      {grpc::StatusCode::INTERNAL, "INTERNAL"},
  };
  for (const auto& [code, name] : terminal) {
    const size_t before = ctx.GRPC.CallsTo("WritePartition").size();
    ctx.GRPC.Fail("WritePartition", code, "the warehouse answered " + name, 1);
    hHlMustFail(ctx, kHLoad, "p-0", "with the warehouse answering " + name);
    ctx.Equal(ctx.GRPC.CallsTo("WritePartition").size() - before, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are retried, every other status stops the load: the attempts with %s", name);
  }
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a status that is not retried must not be slept on; the sleeps");
  ctx.GRPC.Fail("WritePartition", grpc::StatusCode::DEADLINE_EXCEEDED, "", 2);
  ctx.Equal(hHlMustWrite(ctx, kHLoad, "p-2"), 260, "DEADLINE_EXCEEDED is retryable: after two failures the third attempt must write p-2");
  ctx.GRPC.Fail("WritePartition", grpc::StatusCode::UNAVAILABLE, "", 2);
  ctx.Equal(hHlMustWrite(ctx, kHLoad, "p-1"), 240, "UNAVAILABLE is retryable: after two failures the third attempt must write p-1");
}
`,
  },
  hints: [
    'Make the warehouse lose the reply of a write that landed: after the retry the partition’s rows are in the table twice. Revoke the loader’s grant: the worker tries three times and sleeps in between.',
    'Without `merge_key` the warehouse runs an INSERT, and the retry is a second INSERT of the same rows. Every `RpcError` takes the same path to the sleep, and the call has no `timeout`, so a stalled warehouse is waited on.',
    'Set `merge_key=f"{load_id}/{partition_id}"`, pass `timeout=DEADLINE_S` on every attempt, and raise `LoadFailed` at once unless `err.code()` is in `RETRYABLE` and attempts are left.',
  ],
  debrief: `A retry is only safe when the write it repeats is idempotent, and a lost reply says nothing about whether the write landed. The merge key hands that question to the warehouse: the second attempt replaces the first, whichever of them landed, and keying by load and partition keeps another day's p-0 out of it. Classifying statuses is the other half. UNAVAILABLE and DEADLINE_EXCEEDED say nothing about the request; PERMISSION_DENIED says everything, so it stops at once with a reason an operator can act on. The deadline bounds what a slow warehouse costs a worker. Production clients add jitter to the backoff and share one retry budget across partitions, so a warehouse outage does not multiply its own traffic.`,
};
