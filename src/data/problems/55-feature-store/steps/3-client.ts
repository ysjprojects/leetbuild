import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Backfill calls with bounded concurrency and honesty',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'offline', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it fans out over the partitions,
calls the warehouse and collects rows. It works on an idle cluster and it produces a training set full
of fake zeros exactly when the warehouse is busy. Find the flaws, fix them, and prove the fix with the
checks below.

Implement the backfill job that materializes one feature version from the offline store:

- The offline store is called once **per partition** over gRPC:
  \`Scan(feature, version, partition, cutoff_ms)\`.
- Every call carries a **60-second deadline**. The draft has no deadline at all, so one slow partition
  pins a worker until the warehouse decides to answer.
- At most **4 partitions** are in flight. The draft launches every partition at once; a backfill that
  opens 200 concurrent scans is a self-inflicted outage for the warehouse and for everyone else using it.
- A partition that ends in \`DEADLINE_EXCEEDED\` is reported **missing**, never zero-filled. The draft
  turns every timeout into rows of \`0.0\`, which is how an infrastructure failure becomes
  plausible-looking training data — a zero the model happily learns from.
- \`PERMISSION_DENIED\` **stops the backfill once**. The draft retries the rejection partition by
  partition, so a bad credential becomes a hot loop against a store that has already said no.
- The scan request carries the **training cutoff** so the offline read is the same point-in-time
  question the online store answers, and the summary distinguishes \`written\` from \`missing\`.

**Failure mode the checks target.** Honesty about infrastructure: a timed-out partition must appear in
the result as missing, not as invented values, and a permission error must end the job instead of
being retried forever.

## What to keep

The per-partition call, the shape of the request and the collection of the summary are fine. The fix is
the concurrency gate, the deadline, and the two error policies.`,
  sequence: {
    participants: ['Backfill job', 'Offline store', 'Online store'],
    messages: [
      {from: 'Backfill job', to: 'Backfill job', label: 'at most 4 partitions in flight', kind: 'sync'},
      {
        from: 'Backfill job',
        to: 'Offline store',
        label: 'Scan(feature, version, partition, cutoff_ms) · 60 s deadline',
        kind: 'sync',
      },
      {from: 'Offline store', to: 'Backfill job', label: 'rows / DEADLINE_EXCEEDED / PERMISSION_DENIED', kind: 'reply'},
      {
        from: 'Backfill job',
        to: 'Backfill job',
        label: 'a timeout is reported missing, never zero-filled',
        kind: 'sync',
      },
      {from: 'Backfill job', to: 'Online store', label: 'materialize written partitions', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'bounded-concurrency',
      title: 'Keeps at most 4 partitions in flight',
      detail:
        'A concurrency limit of 4 gates the scan calls, so a 200-partition backfill does not become 200 concurrent requests. The draft launches every partition at once.',
      match: {
        python: {all: [/MAX_CONCURRENCY/, /Semaphore\(MAX_CONCURRENCY\)/]},
        typescript: {all: [/MAX_CONCURRENCY/, /slice\(i,\s*i \+ MAX_CONCURRENCY\)/]},
        go: {all: [/maxConcurrency/, /make\(chan struct\{\}, maxConcurrency\)/]},
        scala: {all: [/MaxConcurrency/, /newFixedThreadPool\(MaxConcurrency\)/]},
        cpp: {all: [/kMaxConcurrency/, /counting_semaphore|std::thread/]},
      },
    },
    {
      id: 'deadline-60s',
      title: 'Gives every partition call a 60-second deadline',
      detail:
        'Each scan carries a 60-second deadline, so one slow partition cannot pin a worker indefinitely. The draft calls with no deadline.',
      match: {
        python: {all: [/PARTITION_DEADLINE_S/, /timeout=PARTITION_DEADLINE_S/]},
        typescript: {all: [/PARTITION_DEADLINE_S/, /Date\.now\(\) \+ PARTITION_DEADLINE_S \* 1000/]},
        go: {all: [/partitionDeadlineS/, /context\.WithTimeout\(\w+, partitionDeadlineS\*time\.Second\)/]},
        scala: {all: [/PartitionDeadlineS/, /withDeadlineAfter\(PartitionDeadlineS, TimeUnit\.SECONDS\)/]},
        cpp: {all: [/kPartitionDeadlineS/, /set_deadline\(/]},
      },
    },
    {
      id: 'timeout-missing',
      title: 'Reports a timed-out partition as missing',
      detail:
        'A `DEADLINE_EXCEEDED` partition lands in `missing`; it is never replaced with invented values. The draft zero-fills the partition, so the training set silently gains fake rows.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /missing/], none: [/zero[-_ ]?fill/i]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /missing/], none: [/zero[-_ ]?fill/i]},
        go: {all: [/codes\.DeadlineExceeded/, /missing/], none: [/zero[-_ ]?fill/i]},
        scala: {all: [/DEADLINE_EXCEEDED/, /missing/], none: [/zero[-_ ]?fill/i]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /missing/], none: [/zero[-_ ]?fill/i]},
      },
    },
    {
      id: 'permission-aborts',
      title: 'Stops the whole backfill on PERMISSION_DENIED',
      detail:
        'A permission rejection ends the job with a single abort instead of being retried per partition. The draft catches the error and tries every remaining partition anyway.',
      match: {
        python: {all: [/PERMISSION_DENIED/, /BackfillAborted/]},
        typescript: {all: [/PERMISSION_DENIED/, /BackfillAborted/]},
        go: {all: [/codes\.PermissionDenied/, /errBackfillAborted/]},
        scala: {all: [/PERMISSION_DENIED/, /BackfillAborted/]},
        cpp: {all: [/PERMISSION_DENIED/, /BackfillAborted/]},
      },
    },
    {
      id: 'cutoff-scan',
      title: 'Scans the offline store as of the training cutoff',
      detail:
        'The scan request carries `cutoff_ms`, so the backfill asks the offline store the same point-in-time question the online store answers. The draft scans whatever is latest.',
      match: {
        python: {all: [/ScanRequest\(/, /cutoff_ms=cutoff_ms/]},
        typescript: {all: [/ScanRequest/, /cutoff_ms/]},
        go: {all: [/ScanRequest\{/, /CutoffMs/]},
        scala: {all: [/ScanRequest\(/, /cutoffMs/]},
        cpp: {all: [/ScanRequest/, /set_cutoff_ms/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import warehouse_pb2
import warehouse_pb2_grpc

channel = grpc.aio.insecure_channel("offline-store:9000")
warehouse = warehouse_pb2_grpc.OfflineStoreStub(channel)


async def backfill(name: str, version: int, cutoff_ms: int, partitions: list[int]) -> dict:
    # TODO: bound the partitions in flight to 4 with a 60-second deadline each, report a timed-out
    # partition as missing instead of zero-filling it, and let a permission rejection stop the
    # backfill instead of being retried partition by partition.
    async def one(partition: int) -> list[dict]:
        while True:
            try:
                reply = await warehouse.Scan(
                    warehouse_pb2.ScanRequest(feature=name, version=version, partition=partition)
                )
                return [{"entity": row.entity, "value": row.value} for row in reply.rows]
            except grpc.aio.AioRpcError as error:
                if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                    return [{"entity": f"e-{partition}", "value": 0.0}]
                continue

    scanned = await asyncio.gather(*(one(partition) for partition in partitions))
    return {"rows": [row for chunk in scanned for row in chunk]}
`,
      solution: `import asyncio

import grpc

import warehouse_pb2
import warehouse_pb2_grpc

MAX_CONCURRENCY = 4
PARTITION_DEADLINE_S = 60

channel = grpc.aio.insecure_channel("offline-store:9000")
warehouse = warehouse_pb2_grpc.OfflineStoreStub(channel)


class BackfillAborted(Exception):
    """The warehouse rejected the credentials: stop the job, do not retry per partition."""


async def scan_partition(name: str, version: int, partition: int, cutoff_ms: int) -> list[dict]:
    request = warehouse_pb2.ScanRequest(
        feature=name,
        version=version,
        partition=partition,
        cutoff_ms=cutoff_ms,
    )
    reply = await warehouse.Scan(request, timeout=PARTITION_DEADLINE_S)
    return [{"entity": row.entity, "value": row.value, "event_ts": row.event_ts} for row in reply.rows]


async def backfill(name: str, version: int, cutoff_ms: int, partitions: list[int]) -> dict:
    written: list[int] = []
    missing: list[int] = []
    limit = asyncio.Semaphore(MAX_CONCURRENCY)

    async def one(partition: int) -> None:
        async with limit:
            try:
                rows = await scan_partition(name, version, partition, cutoff_ms)
            except grpc.aio.AioRpcError as error:
                if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                    missing.append(partition)
                    return
                if error.code() == grpc.StatusCode.PERMISSION_DENIED:
                    raise BackfillAborted("warehouse rejected the backfill") from error
                raise
            if rows:
                written.append(partition)

    results = await asyncio.gather(*(one(partition) for partition in partitions), return_exceptions=True)
    for result in results:
        if isinstance(result, BackfillAborted):
            raise result
    return {"written": written, "missing": missing}
`,
    },
    typescript: {
      starter: `/** Backfill a feature version: a model-generated draft that trusts the warehouse to be fast. */
import * as grpc from '@grpc/grpc-js';

import {warehouse} from './warehouse';

interface Row {
  entity: string;
  value: number;
  event_ts: number;
}

export async function backfill(
  name: string,
  version: number,
  cutoff: number,
  partitions: number[],
): Promise<{rows: Row[]}> {
  // TODO: bound the partitions in flight to 4 with a 60-second deadline each, report a timed-out
  // partition as missing instead of zero-filling it, and let a permission rejection stop the
  // backfill instead of being retried partition by partition.
  const scanned = await Promise.all(
    partitions.map(async partition => {
      try {
        const reply = await warehouse.Scan({feature: name, version, partition});
        return reply.rows;
      } catch (error) {
        if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
          return [{entity: \`e-\${partition}\`, value: 0, event_ts: cutoff}];
        }
        throw error;
      }
    }),
  );
  return {rows: scanned.flat()};
}
`,
      solution: `/** Backfill a feature version from the offline store, with a bounded fan-out and honest failures. */
import * as grpc from '@grpc/grpc-js';

import {warehouse} from './warehouse';

const MAX_CONCURRENCY = 4;
const PARTITION_DEADLINE_S = 60;

export class BackfillAborted extends Error {}

interface ScanRequest {
  feature: string;
  version: number;
  partition: number;
  cutoff_ms: number;
}

interface Row {
  entity: string;
  value: number;
  event_ts: number;
}

async function scanPartition(
  name: string,
  version: number,
  partition: number,
  cutoff: number,
): Promise<Row[] | null> {
  const request: ScanRequest = {feature: name, version, partition, cutoff_ms: cutoff};
  try {
    const reply = await warehouse.Scan(request, {deadline: Date.now() + PARTITION_DEADLINE_S * 1000});
    return reply.rows;
  } catch (error) {
    const code = (error as grpc.ServiceError).code;
    if (code === grpc.status.PERMISSION_DENIED) throw new BackfillAborted('warehouse rejected the backfill');
    if (code === grpc.status.DEADLINE_EXCEEDED) return null;
    throw error;
  }
}

export async function backfill(
  name: string,
  version: number,
  cutoff: number,
  partitions: number[],
): Promise<{written: number[]; missing: number[]}> {
  const written: number[] = [];
  const missing: number[] = [];
  for (let i = 0; i < partitions.length; i += MAX_CONCURRENCY) {
    const group = partitions.slice(i, i + MAX_CONCURRENCY);
    const scanned = await Promise.all(
      group.map(partition => scanPartition(name, version, partition, cutoff)),
    );
    scanned.forEach((rows, offset) => {
      const partition = group[offset];
      if (rows === null) missing.push(partition);
      else if (rows.length > 0) written.push(partition);
    });
  }
  return {written, missing};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "featurestore/warehousepb"
)

func backfill(ctx context.Context, client pb.OfflineStoreClient, name string, partitions []int) map[string]any {
	// TODO: bound the partitions in flight to 4 with a 60-second deadline each, report a timed-out
	// partition as missing instead of zero-filling it, and let a permission rejection stop the
	// backfill instead of being retried partition by partition.
	results := make(chan []float64, len(partitions))
	for _, partition := range partitions {
		go func(partition int) {
			reply, err := client.Scan(ctx, &pb.ScanRequest{Feature: name, Partition: int64(partition)})
			if err != nil {
				results <- []float64{0, 0}
				return
			}
			values := make([]float64, 0, len(reply.Rows))
			for _, row := range reply.Rows {
				values = append(values, row.Value)
			}
			results <- values
		}(partition)
	}
	rows := []float64{}
	for range partitions {
		rows = append(rows, <-results...)
	}
	return map[string]any{"rows": rows}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "featurestore/warehousepb"
)

const (
	maxConcurrency     = 4
	partitionDeadlineS = 60
)

var errBackfillAborted = errors.New("warehouse rejected the backfill")

type partitionResult struct {
	partition int
	rows      int
	missing   bool
	aborted   bool
}

func scanPartition(
	client pb.OfflineStoreClient,
	parent context.Context,
	name string,
	version int,
	partition int,
	cutoffMs int64) (int, error) {
	ctx, cancel := context.WithTimeout(parent, partitionDeadlineS*time.Second)
	defer cancel()
	reply, err := client.Scan(ctx, &pb.ScanRequest{
		Feature:   name,
		Version:   int64(version),
		Partition: int64(partition),
		CutoffMs:  cutoffMs,
	})
	if err != nil {
		return 0, err
	}
	return len(reply.Rows), nil
}

func backfill(
	parent context.Context,
	client pb.OfflineStoreClient,
	name string,
	version int,
	cutoffMs int64,
	partitions []int) (map[string]any, error) {
	written := []int{}
	missing := []int{}
	limit := make(chan struct{}, maxConcurrency)
	done := make(chan partitionResult, len(partitions))

	for _, partition := range partitions {
		go func(partition int) {
			limit <- struct{}{}
			defer func() { <-limit }()
			rows, err := scanPartition(client, parent, name, version, partition, cutoffMs)
			switch {
			case err == nil:
				done <- partitionResult{partition: partition, rows: rows}
			case status.Code(err) == codes.PermissionDenied:
				done <- partitionResult{partition: partition, aborted: true}
			case status.Code(err) == codes.DeadlineExceeded:
				done <- partitionResult{partition: partition, missing: true}
			default:
				done <- partitionResult{partition: partition, missing: true}
			}
		}(partition)
	}

	for range partitions {
		result := <-done
		if result.aborted {
			return nil, errBackfillAborted
		}
		if result.missing {
			missing = append(missing, result.partition)
			continue
		}
		if result.rows > 0 {
			written = append(written, result.partition)
		}
	}
	return map[string]any{"written": written, "missing": missing}, nil
}
`,
    },
    scala: {
      starter: `import scala.concurrent.{Await, ExecutionContext, Future}
import scala.concurrent.duration.Duration

object BackfillRunner {
  def backfill(
      stub: WarehouseGrpc.WarehouseStub,
      name: String,
      version: Int,
      partitions: List[Int]): List[Double] = {
    // TODO: bound the partitions in flight to 4 with a 60-second deadline each, report a timed-out
    // partition as missing instead of zero-filling it, and let a permission rejection stop the
    // backfill instead of being retried partition by partition.
    implicit val ec: ExecutionContext = ExecutionContext.global
    Await
      .result(
        Future.sequence(partitions.map { partition =>
          Future {
            try stub.scan(ScanRequest(name, version, partition, 0L)).rows.map(_.value)
            catch { case _: io.grpc.StatusRuntimeException => List(0.0, 0.0) }
          }
        }),
        Duration.Inf)
      .flatten
  }
}
`,
      solution: `import java.util.concurrent.{Executors, TimeUnit}
import java.util.concurrent.ConcurrentLinkedQueue

import scala.concurrent.{Await, ExecutionContext, Future}
import scala.concurrent.duration.Duration
import scala.jdk.CollectionConverters._

import io.grpc.Status

object BackfillRunner {
  val MaxConcurrency = 4
  val PartitionDeadlineS = 60L

  class BackfillAborted(message: String) extends Exception(message)

  def backfill(
      stub: WarehouseGrpc.WarehouseStub,
      name: String,
      version: Int,
      cutoffMs: Long,
      partitions: List[Int]): Map[String, List[Int]] = {
    implicit val ec: ExecutionContext =
      ExecutionContext.fromExecutor(Executors.newFixedThreadPool(MaxConcurrency))
    val written = new ConcurrentLinkedQueue[Int]()
    val missing = new ConcurrentLinkedQueue[Int]()

    val attempts = partitions.map { partition =>
      Future {
        val client = stub.withDeadlineAfter(PartitionDeadlineS, TimeUnit.SECONDS)
        try {
          val reply = client.scan(ScanRequest(name, version, partition, cutoffMs))
          if (reply.rows.nonEmpty) written.add(partition)
        } catch {
          case error: io.grpc.StatusRuntimeException
              if error.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
            throw new BackfillAborted("warehouse rejected the backfill")
          case error: io.grpc.StatusRuntimeException
              if error.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
            missing.add(partition)
        }
      }
    }
    attempts.foreach(attempt => Await.result(attempt, Duration.Inf))
    Map("written" -> written.asScala.toList, "missing" -> missing.asScala.toList)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "warehouse.grpc.pb.h"

#include <mutex>
#include <string>
#include <thread>
#include <vector>

int run_backfill(Warehouse::Stub& warehouse, const std::string& name, const std::vector<int>& partitions) {
  // TODO: bound the partitions in flight to 4 with a 60-second deadline each, report a timed-out
  // partition as missing instead of zero-filling it, and let a permission rejection stop the
  // backfill instead of being retried partition by partition.
  std::vector<double> rows;
  std::mutex mutex;
  std::vector<std::thread> workers;

  for (int partition : partitions) {
    workers.emplace_back([&, partition] {
      grpc::ClientContext ctx;
      ScanRequest request;
      request.set_feature(name);
      request.set_partition(partition);
      ScanReply reply;
      const auto status = warehouse.Scan(&ctx, request, &reply);
      std::lock_guard<std::mutex> lock(mutex);
      if (status.ok()) {
        for (int i = 0; i < reply.rows_size(); ++i) rows.push_back(reply.rows(i).value());
      } else {
        rows.push_back(0.0);
      }
    });
  }

  for (auto& worker : workers) worker.join();
  return static_cast<int>(rows.size());
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "warehouse.grpc.pb.h"

#include <chrono>
#include <mutex>
#include <semaphore>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

constexpr int kMaxConcurrency = 4;
constexpr long long kPartitionDeadlineS = 60;

class BackfillAborted : public std::runtime_error {
 public:
  explicit BackfillAborted(const std::string& message) : std::runtime_error(message) {}
};

int run_backfill(
    Warehouse::Stub& warehouse,
    const std::string& name,
    int version,
    long long cutoff_ms,
    const std::vector<int>& partitions) {
  std::vector<int> written;
  std::vector<int> missing;
  std::mutex mutex;
  bool aborted = false;
  std::counting_semaphore<kMaxConcurrency> slots(kMaxConcurrency);
  std::vector<std::thread> workers;

  for (int partition : partitions) {
    workers.emplace_back([&, partition] {
      slots.acquire();
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kPartitionDeadlineS));
      ScanRequest request;
      request.set_feature(name);
      request.set_version(version);
      request.set_partition(partition);
      request.set_cutoff_ms(cutoff_ms);
      ScanReply reply;
      const auto status = warehouse.Scan(&ctx, request, &reply);
      std::lock_guard<std::mutex> lock(mutex);
      if (status.ok()) {
        if (reply.rows_size() > 0) written.push_back(partition);
      } else if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
        missing.push_back(partition);
      } else if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) {
        aborted = true;
      }
      slots.release();
    });
  }

  for (auto& worker : workers) worker.join();
  if (aborted) throw BackfillAborted("warehouse rejected the backfill");
  return static_cast<int>(missing.size());
}
`,
    },
  },
  hints: [
    'A backfill is a client of a shared warehouse: four partitions in flight (`asyncio.Semaphore`, a fixed worker pool, a buffered channel, a counting semaphore) is the difference between a batch job and a denial-of-service attack. The deadline belongs on every call, not on the job: 60 seconds per partition, so a slow one fails alone.',
    'A timeout is information, not a value. `DEADLINE_EXCEEDED` belongs in a `missing` list that the caller can retry later; turning it into `0.0` rows is how an infrastructure failure becomes plausible-looking training data that nobody can explain.',
    'A permission rejection is a property of the credential, not of the partition: the first `PERMISSION_DENIED` ends the job with one abort. Retrying it per partition hammers a store that has already answered, and the answer will not change until the job does.',
  ],
  debrief: `The interview question behind this step is honest failure propagation from a dependency. A warehouse is shared, rate-limited and occasionally slow, so a backfill has three obligations the draft ignores. Bounded concurrency protects the dependency and the job's own memory; a per-call deadline turns "slow" into a decision the job can make instead of a hang; and the two error policies are deliberately different — a timeout is transient, so the partition is reported missing and can be retried by whoever owns the schedule, while a permission rejection is terminal, so the job stops once instead of burning the warehouse with retries that cannot succeed. The subtle part is what \`missing\` prevents: a zero-fill looks like data, it passes every schema check, and it quietly teaches a model that the feature is zero in exactly the situations where the pipeline was broken.`,
};
