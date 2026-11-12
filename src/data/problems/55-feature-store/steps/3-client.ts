import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Backfill scans with a deadline, a cutoff and honest gaps',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['worker', 'offline', 'redis'],
  task: `## Task

**Starting point.** The starter is the backfill's client of the offline store:
\`backfill(name, version, partitions, as_of)\` calls \`Scan\` once per partition over gRPC, turns each
answer into rows (\`entity\`, \`value\` or \`None\` for a null, \`event_ts\`) and returns
\`{"scanned": {partition: rows}, "missing": [...]}\`; a call that fails becomes an empty partition.
With a healthy store it backfills, and it hides four flaws.

**Failure mode the checks target.** One slow partition holds the backfill open for ten minutes; a
model trained on the backfill sees values computed after its training cutoff; a partition that
timed out is reported as scanned and empty, a hole nobody sees; a job the warehouse refuses keeps
scanning every partition.

\`\`\`proto
service OfflineStore { rpc Scan(ScanRequest) returns (ScanResponse); }  // PERMISSION_DENIED: refused
\`\`\`

- Every \`Scan\` carries a **\`DEADLINE_S\` = 60 s** deadline.
- The request carries the training cutoff, **\`as_of\`** (epoch seconds): the store then answers the
  newest value at or before it.
- A partition whose call fails (\`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\`, …) goes to **\`missing\`** and
  stays out of \`scanned\`.
- \`PERMISSION_DENIED\` raises **\`BackfillAborted\`** at once: no further partition is scanned.`,
  sequence: {
    participants: ['Backfill worker', 'Offline store'],
    messages: [
      {
        from: 'Backfill worker',
        to: 'Offline store',
        label: 'Scan(amount_7d, 2, 2026-10-01, as_of) · 60 s',
        kind: 'sync',
      },
      {from: 'Offline store', to: 'Backfill worker', label: 'rows at or before as_of', kind: 'reply'},
      {from: 'Backfill worker', to: 'Offline store', label: 'Scan(…, 2026-10-02, as_of) · 60 s', kind: 'sync'},
      {from: 'Offline store', to: 'Backfill worker', label: 'DEADLINE_EXCEEDED → missing', kind: 'reply'},
      {from: 'Backfill worker', to: 'Offline store', label: 'Scan(…, 2026-10-03, as_of) · 60 s', kind: 'sync'},
      {from: 'Offline store', to: 'Backfill worker', label: 'PERMISSION_DENIED → BackfillAborted, stop', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Scan carries a 60-second deadline',
      detail:
        'Each `Scan` is made with `DEADLINE_S` (60 s), so a partition the store takes ten minutes over costs the backfill one minute. The starter gives the call no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*60\b/, /\.Scan\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*60_?000\b/, /\.Scan\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*60\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*60L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{60\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'as-of-cutoff',
      title: 'Scans as of the training cutoff',
      detail:
        "The request carries `as_of`, the cutoff the caller passed, so no scanned value is newer than it; the starter's request leaves it unset (0), and the store answers its newest values.",
      match: {
        python: {all: [/as_of\s*=\s*as_of/]},
        typescript: {all: [/as_of:\s*asOf/]},
        go: {all: [/AsOf:\s*asOf/]},
        scala: {all: [/asOf\s*=\s*asOf/]},
        cpp: {all: [/set_as_of\(\s*as_of\s*\)/]},
      },
    },
    {
      id: 'missing-partitions',
      title: 'Reports a failed partition as missing',
      detail:
        'A partition whose `Scan` fails with `DEADLINE_EXCEEDED`, `UNAVAILABLE` or another non-permission code is listed in `missing` and absent from `scanned`. The starter records it as an empty partition.',
      match: {
        python: {all: [/missing\.append\(/], none: [/\[partition\]\s*=\s*\[\]/]},
        typescript: {all: [/missing\.push\(/], none: [/\[partition\]\s*=\s*\[\]/]},
        go: {all: [/Missing\s*=\s*append\(/], none: [/\[partition\]\s*=\s*nil/]},
        scala: {all: [/missing\s*\+=/], none: [/\(partition\)\s*=\s*(?:Seq\.empty|Nil\b)/]},
        cpp: {all: [/missing\.push_back\(/], none: [/\[partition\]\s*=\s*\{\}/]},
      },
    },
    {
      id: 'permission-abort',
      title: 'A refused scan aborts the backfill',
      detail:
        '`PERMISSION_DENIED` raises `BackfillAborted` right away: one refused call, no later partition scanned. The starter treats it like any other failure and goes on to the next partition.',
      match: {
        python: {all: [/PERMISSION_DENIED/, /raise BackfillAborted/]},
        typescript: {all: [/PERMISSION_DENIED/, /throw new BackfillAborted/]},
        go: {all: [/codes\.PermissionDenied/, /ErrBackfillAborted/]},
        scala: {all: [/PERMISSION_DENIED/, /throw new BackfillAborted/]},
        cpp: {all: [/PERMISSION_DENIED/, /throw BackfillAborted/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import feature_store_pb2
import feature_store_pb2_grpc

offline = feature_store_pb2_grpc.OfflineStoreStub(grpc.insecure_channel("offline:9000"))


class BackfillAborted(Exception):
    """The warehouse refused the scan: no more of this backfill may run."""


def scan_partition(name: str, version: int, partition: str, as_of: int) -> list[dict]:
    response = offline.Scan(feature_store_pb2.ScanRequest(feature=name, version=version, partition=partition))
    return [{"entity": row.entity, "value": None if row.is_null else row.value, "event_ts": row.event_ts} for row in response.rows]


def backfill(name: str, version: int, partitions: list[str], as_of: int) -> dict:
    """Scan every partition of the feature version as of the training cutoff (epoch seconds)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    scanned, missing = {}, []
    for partition in partitions:
        try:
            scanned[partition] = scan_partition(name, version, partition, as_of)
        except grpc.RpcError:
            scanned[partition] = []  # nothing came back: an empty partition
    return {"scanned": scanned, "missing": missing}
`,
      solution: `import grpc

import feature_store_pb2
import feature_store_pb2_grpc

DEADLINE_S = 60

offline = feature_store_pb2_grpc.OfflineStoreStub(grpc.insecure_channel("offline:9000"))


class BackfillAborted(Exception):
    """The warehouse refused the scan: no more of this backfill may run."""


def scan_partition(name: str, version: int, partition: str, as_of: int) -> list[dict]:
    response = offline.Scan(
        feature_store_pb2.ScanRequest(feature=name, version=version, partition=partition, as_of=as_of),
        timeout=DEADLINE_S,
    )
    return [{"entity": row.entity, "value": None if row.is_null else row.value, "event_ts": row.event_ts} for row in response.rows]


def backfill(name: str, version: int, partitions: list[str], as_of: int) -> dict:
    """Scan every partition of the feature version as of the training cutoff (epoch seconds)."""
    scanned, missing = {}, []
    for partition in partitions:
        try:
            scanned[partition] = scan_partition(name, version, partition, as_of)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.PERMISSION_DENIED:
                # The job itself is refused: every later partition would be refused too.
                raise BackfillAborted(f"the warehouse refused {name} v{version}: {exc.details()}") from exc
            # Timed out or unreachable: a gap the training job must see, not an empty partition.
            missing.append(partition)
    return {"scanned": scanned, "missing": missing}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Row} from 'features/online';

interface ScanRequest {
  feature: string;
  version: number;
  partition: string;
  as_of?: number;
}

interface ScanRow {
  entity: string;
  value: number;
  is_null: boolean;
  event_ts: number | string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('feature_store.proto')) as unknown as {
  featurestore: {OfflineStore: grpc.ServiceClientConstructor};
};
const offline = new pkg.featurestore.OfflineStore('offline:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Scan(request: ScanRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows: ScanRow[]}>;
};

/** The warehouse refused the scan: no more of this backfill may run. */
export class BackfillAborted extends Error {}

export interface BackfillResult {
  scanned: Record<string, Row[]>;
  missing: string[];
}

async function scanPartition(name: string, version: number, partition: string, asOf: number): Promise<Row[]> {
  const response = await offline.Scan({feature: name, version, partition}, new grpc.Metadata(), {});
  return response.rows.map(row => ({entity: row.entity, value: row.is_null ? null : row.value, event_ts: Number(row.event_ts)}));
}

/** Scan every partition of the feature version as of the training cutoff (epoch seconds). */
export async function backfill(name: string, version: number, partitions: string[], asOf: number): Promise<BackfillResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const scanned: Record<string, Row[]> = {};
  const missing: string[] = [];
  for (const partition of partitions) {
    try {
      scanned[partition] = await scanPartition(name, version, partition, asOf);
    } catch {
      scanned[partition] = []; // nothing came back: an empty partition
    }
  }
  return {scanned, missing};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Row} from 'features/online';

export const DEADLINE_MS = 60_000;

interface ScanRequest {
  feature: string;
  version: number;
  partition: string;
  as_of?: number;
}

interface ScanRow {
  entity: string;
  value: number;
  is_null: boolean;
  event_ts: number | string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('feature_store.proto')) as unknown as {
  featurestore: {OfflineStore: grpc.ServiceClientConstructor};
};
const offline = new pkg.featurestore.OfflineStore('offline:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Scan(request: ScanRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{rows: ScanRow[]}>;
};

/** The warehouse refused the scan: no more of this backfill may run. */
export class BackfillAborted extends Error {}

export interface BackfillResult {
  scanned: Record<string, Row[]>;
  missing: string[];
}

async function scanPartition(name: string, version: number, partition: string, asOf: number): Promise<Row[]> {
  const response = await offline.Scan({feature: name, version, partition, as_of: asOf}, new grpc.Metadata(), {
    deadline: Date.now() + DEADLINE_MS,
  });
  return response.rows.map(row => ({entity: row.entity, value: row.is_null ? null : row.value, event_ts: Number(row.event_ts)}));
}

/** Scan every partition of the feature version as of the training cutoff (epoch seconds). */
export async function backfill(name: string, version: number, partitions: string[], asOf: number): Promise<BackfillResult> {
  const scanned: Record<string, Row[]> = {};
  const missing: string[] = [];
  for (const partition of partitions) {
    try {
      scanned[partition] = await scanPartition(name, version, partition, asOf);
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      // The job itself is refused: every later partition would be refused too.
      if (code === grpc.status.PERMISSION_DENIED) throw new BackfillAborted(\`the warehouse refused \${name} v\${version}: \${details}\`);
      // Timed out or unreachable: a gap the training job must see, not an empty partition.
      missing.push(partition);
    }
  }
  return {scanned, missing};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "features/gen/feature_store"
	"features/online" // online.Row
)

var (
	offlineConn, _ = grpc.NewClient("offline:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	offline        = pb.NewOfflineStoreClient(offlineConn)
)

// ErrBackfillAborted: the warehouse refused the scan, no more of this backfill may run.
var ErrBackfillAborted = errors.New("backfill aborted: the warehouse refused the scan")

// BackfillResult is what a backfill scanned, by partition, and the partitions it could not.
type BackfillResult struct {
	Scanned map[string][]online.Row
	Missing []string
}

func scanPartition(ctx context.Context, name string, version int, partition string, asOf int64) ([]online.Row, error) {
	resp, err := offline.Scan(ctx, &pb.ScanRequest{Feature: name, Version: int64(version), Partition: partition})
	if err != nil {
		return nil, err
	}
	rows := make([]online.Row, 0, len(resp.GetRows()))
	for _, r := range resp.GetRows() {
		row := online.Row{Entity: r.GetEntity(), EventTs: r.GetEventTs()}
		if !r.GetIsNull() {
			value := r.GetValue()
			row.Value = &value
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// backfill scans every partition of the feature version as of the training cutoff (epoch seconds).
func backfill(ctx context.Context, name string, version int, partitions []string, asOf int64) (*BackfillResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	result := &BackfillResult{Scanned: map[string][]online.Row{}}
	for _, partition := range partitions {
		rows, err := scanPartition(ctx, name, version, partition, asOf)
		if err != nil {
			result.Scanned[partition] = nil // nothing came back: an empty partition
			continue
		}
		result.Scanned[partition] = rows
	}
	return result, nil
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

	pb "features/gen/feature_store"
	"features/online" // online.Row
)

const deadline = 60 * time.Second

var (
	offlineConn, _ = grpc.NewClient("offline:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	offline        = pb.NewOfflineStoreClient(offlineConn)
)

// ErrBackfillAborted: the warehouse refused the scan, no more of this backfill may run.
var ErrBackfillAborted = errors.New("backfill aborted: the warehouse refused the scan")

// BackfillResult is what a backfill scanned, by partition, and the partitions it could not.
type BackfillResult struct {
	Scanned map[string][]online.Row
	Missing []string
}

func scanPartition(ctx context.Context, name string, version int, partition string, asOf int64) ([]online.Row, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	resp, err := offline.Scan(callCtx, &pb.ScanRequest{Feature: name, Version: int64(version), Partition: partition, AsOf: asOf})
	if err != nil {
		return nil, err
	}
	rows := make([]online.Row, 0, len(resp.GetRows()))
	for _, r := range resp.GetRows() {
		row := online.Row{Entity: r.GetEntity(), EventTs: r.GetEventTs()}
		if !r.GetIsNull() {
			value := r.GetValue()
			row.Value = &value
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// backfill scans every partition of the feature version as of the training cutoff (epoch seconds).
func backfill(ctx context.Context, name string, version int, partitions []string, asOf int64) (*BackfillResult, error) {
	result := &BackfillResult{Scanned: map[string][]online.Row{}}
	for _, partition := range partitions {
		rows, err := scanPartition(ctx, name, version, partition, asOf)
		if err != nil {
			if status.Code(err) == codes.PermissionDenied {
				// The job itself is refused: every later partition would be refused too.
				return nil, fmt.Errorf("%w: %s v%d: %s", ErrBackfillAborted, name, version, status.Convert(err).Message())
			}
			// Timed out or unreachable: a gap the training job must see, not an empty partition.
			result.Missing = append(result.Missing, partition)
			continue
		}
		result.Scanned[partition] = rows
	}
	return result, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import features.Online // Online.Row
import featurestore.feature_store.{OfflineStoreGrpc, ScanRequest}

/** The warehouse refused the scan: no more of this backfill may run. */
final class BackfillAborted(message: String) extends Exception(message)

object Client {
  final case class BackfillResult(scanned: Map[String, Seq[Online.Row]], missing: Seq[String])

  private val offline = OfflineStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("offline", 9000).usePlaintext().build())

  def scanPartition(name: String, version: Long, partition: String, asOf: Long): Seq[Online.Row] =
    offline
      .scan(ScanRequest(feature = name, version = version, partition = partition))
      .rows
      .map(row => Online.Row(row.entity, if (row.isNull) None else Some(row.value), row.eventTs))

  /** Scan every partition of the feature version as of the training cutoff (epoch seconds). */
  def backfill(name: String, version: Long, partitions: Seq[String], asOf: Long): BackfillResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val scanned = scala.collection.mutable.LinkedHashMap.empty[String, Seq[Online.Row]]
    val missing = scala.collection.mutable.ArrayBuffer.empty[String]
    partitions.foreach { partition =>
      try scanned(partition) = scanPartition(name, version, partition, asOf)
      catch { case _: StatusRuntimeException => scanned(partition) = Seq.empty } // nothing came back: an empty partition
    }
    BackfillResult(scanned.toMap, missing.toSeq)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import features.Online // Online.Row
import featurestore.feature_store.{OfflineStoreGrpc, ScanRequest}

/** The warehouse refused the scan: no more of this backfill may run. */
final class BackfillAborted(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 60L

  final case class BackfillResult(scanned: Map[String, Seq[Online.Row]], missing: Seq[String])

  private val offline = OfflineStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("offline", 9000).usePlaintext().build())

  def scanPartition(name: String, version: Long, partition: String, asOf: Long): Seq[Online.Row] =
    offline
      .withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
      .scan(ScanRequest(feature = name, version = version, partition = partition, asOf = asOf))
      .rows
      .map(row => Online.Row(row.entity, if (row.isNull) None else Some(row.value), row.eventTs))

  /** Scan every partition of the feature version as of the training cutoff (epoch seconds). */
  def backfill(name: String, version: Long, partitions: Seq[String], asOf: Long): BackfillResult = {
    val scanned = scala.collection.mutable.LinkedHashMap.empty[String, Seq[Online.Row]]
    val missing = scala.collection.mutable.ArrayBuffer.empty[String]
    partitions.foreach { partition =>
      try scanned(partition) = scanPartition(name, version, partition, asOf)
      catch {
        // The job itself is refused: every later partition would be refused too.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
          throw new BackfillAborted(s"the warehouse refused $name v$version: \${e.getStatus.getDescription}")
        // Timed out or unreachable: a gap the training job must see, not an empty partition.
        case _: StatusRuntimeException => missing += partition
      }
    }
    BackfillResult(scanned.toMap, missing.toSeq)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "feature_store.grpc.pb.h"
#include "features/online.h"  // online::Row

auto offline = featurestore::OfflineStore::NewStub(grpc::CreateChannel("offline:9000", grpc::InsecureChannelCredentials()));

// The warehouse refused the scan: no more of this backfill may run.
struct BackfillAborted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// What a backfill scanned, by partition, and the partitions it could not.
struct BackfillResult {
  std::map<std::string, std::vector<online::Row>> scanned;
  std::vector<std::string> missing;
};

grpc::Status scanPartition(const std::string& name, long version, const std::string& partition, long long as_of, std::vector<online::Row>& rows) {
  grpc::ClientContext ctx;
  featurestore::ScanRequest request;
  request.set_feature(name);
  request.set_version(version);
  request.set_partition(partition);
  featurestore::ScanResponse response;
  const grpc::Status status = offline->Scan(&ctx, request, &response);
  if (!status.ok()) return status;
  for (const auto& row : response.rows()) {
    rows.push_back(online::Row{row.entity(), row.is_null() ? std::nullopt : std::optional<double>(row.value()), row.event_ts()});
  }
  return status;
}

// Scan every partition of the feature version as of the training cutoff (epoch seconds).
BackfillResult backfill(const std::string& name, long version, const std::vector<std::string>& partitions, long long as_of) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  BackfillResult result;
  for (const std::string& partition : partitions) {
    std::vector<online::Row> rows;
    const grpc::Status status = scanPartition(name, version, partition, as_of, rows);
    if (!status.ok()) {
      result.scanned[partition] = {};  // nothing came back: an empty partition
      continue;
    }
    result.scanned[partition] = rows;
  }
  return result;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "feature_store.grpc.pb.h"
#include "features/online.h"  // online::Row

constexpr std::chrono::seconds kDeadline{60};

auto offline = featurestore::OfflineStore::NewStub(grpc::CreateChannel("offline:9000", grpc::InsecureChannelCredentials()));

// The warehouse refused the scan: no more of this backfill may run.
struct BackfillAborted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// What a backfill scanned, by partition, and the partitions it could not.
struct BackfillResult {
  std::map<std::string, std::vector<online::Row>> scanned;
  std::vector<std::string> missing;
};

grpc::Status scanPartition(const std::string& name, long version, const std::string& partition, long long as_of, std::vector<online::Row>& rows) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  featurestore::ScanRequest request;
  request.set_feature(name);
  request.set_version(version);
  request.set_partition(partition);
  request.set_as_of(as_of);
  featurestore::ScanResponse response;
  const grpc::Status status = offline->Scan(&ctx, request, &response);
  if (!status.ok()) return status;
  for (const auto& row : response.rows()) {
    rows.push_back(online::Row{row.entity(), row.is_null() ? std::nullopt : std::optional<double>(row.value()), row.event_ts()});
  }
  return status;
}

// Scan every partition of the feature version as of the training cutoff (epoch seconds).
BackfillResult backfill(const std::string& name, long version, const std::vector<std::string>& partitions, long long as_of) {
  BackfillResult result;
  for (const std::string& partition : partitions) {
    std::vector<online::Row> rows;
    const grpc::Status status = scanPartition(name, version, partition, as_of, rows);
    if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) {
      // The job itself is refused: every later partition would be refused too.
      throw BackfillAborted("the warehouse refused " + name + " v" + std::to_string(version) + ": " + status.error_message());
    }
    if (!status.ok()) {
      // Timed out or unreachable: a gap the training job must see, not an empty partition.
      result.missing.push_back(partition);
      continue;
    }
    result.scanned[partition] = rows;
  }
  return result;
}
`,
    },
  },
  harness: {
    python: `import time

import grpc

import feature_store_pb2
import feature_store_pb2_grpc

CUTOFF = 1_790_000_000
PARTS = ["2026-10-01", "2026-10-02", "2026-10-03"]


class Offline(feature_store_pb2_grpc.OfflineStoreServicer):
    """Two entities per partition, each with a value an hour before the cutoff and one an hour after; a third entity is null."""

    def __init__(self):
        self.failing = {}

    def Scan(self, request, context):
        if request.partition in self.failing:
            context.abort(self.failing[request.partition], f"partition {request.partition} failed")
        rows = []
        for i in (1, 2):
            history = [(CUTOFF - 3600, 10.0 * i), (CUTOFF + 3600, 99.0)]
            ts, value = max(h for h in history if request.as_of == 0 or h[0] <= request.as_of)
            rows.append(feature_store_pb2.ScanRow(entity=f"{request.partition}/e-{i}", value=value, event_ts=ts))
        rows.append(feature_store_pb2.ScanRow(entity=f"{request.partition}/e-3", is_null=True, event_ts=CUTOFF - 3600))
        return feature_store_pb2.ScanResponse(rows=rows)


def _client(ctx):
    offline = Offline()
    ctx.grpc.serve(feature_store_pb2_grpc.add_OfflineStoreServicer_to_server, offline)
    return ctx.load("client"), offline


def check_deadline(ctx):
    m, _ = _client(ctx)
    m.backfill("amount_7d", 2, PARTS, CUTOFF)
    calls = ctx.grpc.calls_to("Scan")
    assert len(calls) == 3, f"three partitions made {len(calls)} Scan calls, expected one per partition"
    for call in calls:
        assert call.timeout is not None, "a Scan call carries no deadline: one stuck partition holds the whole backfill open"
        assert 59.5 <= call.timeout <= 60.5, f"a Scan call carries a {call.timeout} s deadline, expected DEADLINE_S = 60"
    ctx.grpc.set_latency("Scan", 600.0)
    before = time.time()
    m.backfill("amount_7d", 2, PARTS[:1], CUTOFF)
    waited = time.time() - before
    assert waited <= 61, f"a partition the store took 600 s over held the backfill for {waited:.0f} s, expected at most the 60 s deadline"


def check_as_of_cutoff(ctx):
    m, _ = _client(ctx)
    result = m.backfill("amount_7d", 2, PARTS, CUTOFF)
    asked = [c.request.as_of for c in ctx.grpc.calls_to("Scan")]
    assert asked == [CUTOFF] * 3, f"the Scan requests carried as_of {asked}, expected the training cutoff {CUTOFF} on every one"
    for partition in PARTS:
        rows = result["scanned"].get(partition, [])
        assert len(rows) == 3, f"partition {partition} scanned {rows}, expected its three rows"
        for row in rows:
            assert row["event_ts"] <= CUTOFF, f"{row['entity']} was scanned with value {row['value']} from {row['event_ts'] - CUTOFF} s after the training cutoff: the model would train on the future"
        nulls = [row for row in rows if row["value"] is None]
        assert len(nulls) == 1, f"partition {partition} must keep its one null row as value None, got {rows}"


def check_missing_partitions(ctx):
    m, offline = _client(ctx)
    offline.failing["2026-10-01"] = grpc.StatusCode.DEADLINE_EXCEEDED
    offline.failing["2026-10-03"] = grpc.StatusCode.UNAVAILABLE
    result = m.backfill("amount_7d", 2, PARTS, CUTOFF)
    assert result["missing"] == ["2026-10-01", "2026-10-03"], f"two partitions failed (DEADLINE_EXCEEDED, UNAVAILABLE) and missing is {result['missing']}, expected ['2026-10-01', '2026-10-03']"
    assert sorted(result["scanned"]) == ["2026-10-02"], f"scanned holds {sorted(result['scanned'])}: a failed partition reported as scanned and empty is a hole in the training set nobody sees"
    assert len(result["scanned"]["2026-10-02"]) == 3, f"the healthy partition scanned {result['scanned']['2026-10-02']}"


def check_permission_abort(ctx):
    m, offline = _client(ctx)
    offline.failing["2026-10-02"] = grpc.StatusCode.PERMISSION_DENIED
    try:
        result = m.backfill("amount_7d", 2, PARTS, CUTOFF)
    except m.BackfillAborted:
        result = None
    except Exception as other:
        raise AssertionError(f"a refused scan raised {type(other).__name__}: {other}, expected BackfillAborted")
    assert result is None, f"a refused scan must raise BackfillAborted; backfill returned {result}"
    asked = [c.request.partition for c in ctx.grpc.calls_to("Scan")]
    assert asked == PARTS[:2], f"after PERMISSION_DENIED on 2026-10-02 the backfill scanned {asked}, expected to stop there"
    assert ctx.clock.sleeps == 0, "a refusal must not be slept on and retried"
`,
    typescript: `const CUTOFF = 1_790_000_000;
const PARTS = ['2026-10-01', '2026-10-02', '2026-10-03'];

/** Two entities per partition, each with a value an hour before the cutoff and one an hour after; a third entity is null. */
function client(ctx) {
  const pkg = ctx.proto('feature_store.proto');
  const failing = new Map<string, number>();
  ctx.grpc.serve(pkg.featurestore.OfflineStore.service, {
    Scan(call, callback) {
      const {partition} = call.request;
      const asOf = Number(call.request.as_of);
      if (failing.has(partition)) return callback({code: failing.get(partition), details: \`partition \${partition} failed\`});
      const rows = [1, 2].map(i => {
        const history: [number, number][] = [[CUTOFF - 3600, 10 * i], [CUTOFF + 3600, 99]];
        const [ts, value] = history.filter(([at]) => asOf === 0 || at <= asOf).pop() as [number, number];
        return {entity: \`\${partition}/e-\${i}\`, value, is_null: false, event_ts: ts};
      });
      rows.push({entity: \`\${partition}/e-3\`, value: 0, is_null: true, event_ts: CUTOFF - 3600});
      callback(null, {rows});
    },
  });
  return {m: ctx.load('client'), failing};
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  await m.backfill('amount_7d', 2, PARTS, CUTOFF);
  const calls = ctx.grpc.callsTo('Scan');
  assert.equal(calls.length, 3, \`three partitions made \${calls.length} Scan calls, expected one per partition\`);
  for (const call of calls) {
    assert(call.timeout !== null, 'a Scan call carries no deadline: one stuck partition holds the whole backfill open');
    assert(59.5 <= call.timeout && call.timeout <= 60.5, \`a Scan call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 60000\`);
  }
  ctx.grpc.setLatency('Scan', 600);
  const before = ctx.clock.now();
  await m.backfill('amount_7d', 2, PARTS.slice(0, 1), CUTOFF);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 61, \`a partition the store took 600 s over held the backfill for \${waited.toFixed(0)} s, expected at most the 60 s deadline\`);
}

export async function check_as_of_cutoff(ctx) {
  const {m} = client(ctx);
  const result = await m.backfill('amount_7d', 2, PARTS, CUTOFF);
  const asked = ctx.grpc.callsTo('Scan').map(c => Number(c.request.as_of));
  assert.deepStrictEqual(asked, [CUTOFF, CUTOFF, CUTOFF], \`the Scan requests carried as_of \${JSON.stringify(asked)}, expected the training cutoff \${CUTOFF} on every one\`);
  for (const partition of PARTS) {
    const rows = result.scanned[partition] ?? [];
    assert.equal(rows.length, 3, \`partition \${partition} scanned \${JSON.stringify(rows)}, expected its three rows\`);
    for (const row of rows) {
      assert(row.event_ts <= CUTOFF, \`\${row.entity} was scanned with value \${row.value} from \${row.event_ts - CUTOFF} s after the training cutoff: the model would train on the future\`);
    }
    assert.equal(rows.filter(r => r.value === null).length, 1, \`partition \${partition} must keep its one null row as value null, got \${JSON.stringify(rows)}\`);
  }
}

export async function check_missing_partitions(ctx) {
  const {m, failing} = client(ctx);
  failing.set('2026-10-01', ctx.grpc.status.DEADLINE_EXCEEDED);
  failing.set('2026-10-03', ctx.grpc.status.UNAVAILABLE);
  const result = await m.backfill('amount_7d', 2, PARTS, CUTOFF);
  const missing = JSON.stringify(result.missing);
  assert.equal(missing, '["2026-10-01","2026-10-03"]', \`two partitions failed (DEADLINE_EXCEEDED, UNAVAILABLE) and missing is \${missing}\`);
  const scanned = JSON.stringify(Object.keys(result.scanned).sort());
  assert.equal(scanned, '["2026-10-02"]', \`scanned holds \${scanned}: a failed partition reported as scanned and empty is a hole in the training set nobody sees\`);
  assert.equal(result.scanned['2026-10-02']?.length, 3, \`the healthy partition must scan its three rows, got \${JSON.stringify(result.scanned['2026-10-02'])}\`);
}

export async function check_permission_abort(ctx) {
  const {m, failing} = client(ctx);
  failing.set('2026-10-02', ctx.grpc.status.PERMISSION_DENIED);
  let result;
  try {
    result = await m.backfill('amount_7d', 2, PARTS, CUTOFF);
  } catch (e) {
    assert(e instanceof m.BackfillAborted, \`a refused scan threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected BackfillAborted\`);
  }
  assert.equal(result, undefined, \`a refused scan must throw BackfillAborted; backfill resolved \${JSON.stringify(result)}\`);
  const asked = ctx.grpc.callsTo('Scan').map(c => c.request.partition);
  assert.deepStrictEqual(asked, PARTS.slice(0, 2), \`after PERMISSION_DENIED on 2026-10-02 the backfill scanned \${JSON.stringify(asked)}, expected to stop there\`);
  assert.equal(ctx.clock.sleeps, 0, 'a refusal must not be slept on and retried');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "features/gen/feature_store"

	"leetbuild/harness"
)

const cutoff int64 = 1_790_000_000

var (
	clientBg = context.Background()
	parts    = []string{"2026-10-01", "2026-10-02", "2026-10-03"}
)

// offlinePeer has two entities per partition, each with a value an hour before the cutoff and one
// an hour after; a third entity is null. A partition in failing fails with its code.
type offlinePeer struct {
	pb.UnimplementedOfflineStoreServer
	failing map[string]codes.Code
}

func (o *offlinePeer) Scan(_ context.Context, req *pb.ScanRequest) (*pb.ScanResponse, error) {
	if code, ok := o.failing[req.GetPartition()]; ok {
		return nil, status.Errorf(code, "partition %s failed", req.GetPartition())
	}
	var rows []*pb.ScanRow
	for i := 1; i <= 2; i++ {
		ts, value := cutoff-3600, 10.0*float64(i)
		if req.GetAsOf() == 0 || cutoff+3600 <= req.GetAsOf() {
			ts, value = cutoff+3600, 99.0
		}
		rows = append(rows, &pb.ScanRow{Entity: fmt.Sprintf("%s/e-%d", req.GetPartition(), i), Value: value, EventTs: ts})
	}
	rows = append(rows, &pb.ScanRow{Entity: req.GetPartition() + "/e-3", IsNull: true, EventTs: cutoff - 3600})
	return &pb.ScanResponse{Rows: rows}, nil
}

func client(ctx *harness.Ctx) *offlinePeer {
	peer := &offlinePeer{failing: map[string]codes.Code{}}
	pb.RegisterOfflineStoreServer(ctx.GRPC.Server(""), peer)
	return peer
}

func mustBackfill(ctx *harness.Ctx, partitions []string) *BackfillResult {
	result, err := backfill(clientBg, "amount_7d", 2, partitions, cutoff)
	ctx.NoError(err, "backfill failed")
	return result
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	mustBackfill(ctx, parts)
	calls := ctx.GRPC.CallsTo("Scan", "")
	ctx.Equal(len(calls), 3, "three partitions must make one Scan call each; the calls")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Scan call carries no deadline: one stuck partition holds the whole backfill open")
		ctx.Assert(59500*time.Millisecond <= call.Timeout && call.Timeout <= 60500*time.Millisecond, "a Scan call carries a %v deadline, expected 60 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Scan", 600, "")
	before := ctx.Clock.Now()
	backfill(clientBg, "amount_7d", 2, parts[:1], cutoff)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 61, "a partition the store took 600 s over held the backfill for %.0f s, expected at most the 60 s deadline", waited)
}

func CheckAsOfCutoff(ctx *harness.Ctx) {
	client(ctx)
	result := mustBackfill(ctx, parts)
	var asked []int64
	for _, c := range ctx.GRPC.CallsTo("Scan", "") {
		asked = append(asked, c.Request.(*pb.ScanRequest).GetAsOf())
	}
	ctx.Equal(asked, []int64{cutoff, cutoff, cutoff}, "every Scan request must carry the training cutoff as as_of; they carried")
	for _, partition := range parts {
		rows := result.Scanned[partition]
		ctx.Equal(len(rows), 3, "partition %s must scan its three rows; the rows", partition)
		nulls := 0
		for _, row := range rows {
			ctx.Assert(row.EventTs <= cutoff, "%s was scanned from %d s after the training cutoff: the model would train on the future", row.Entity, row.EventTs-cutoff)
			if row.Value == nil {
				nulls++
			}
		}
		ctx.Equal(nulls, 1, "partition %s must keep its one null row with a nil Value; the nulls", partition)
	}
}

func CheckMissingPartitions(ctx *harness.Ctx) {
	peer := client(ctx)
	peer.failing["2026-10-01"] = codes.DeadlineExceeded
	peer.failing["2026-10-03"] = codes.Unavailable
	result := mustBackfill(ctx, parts)
	ctx.Equal(result.Missing, []string{"2026-10-01", "2026-10-03"}, "two partitions failed (DEADLINE_EXCEEDED, UNAVAILABLE); missing")
	var scanned []string
	for partition := range result.Scanned {
		scanned = append(scanned, partition)
	}
	sort.Strings(scanned)
	ctx.Equal(scanned, []string{"2026-10-02"}, "a failed partition reported as scanned and empty is a hole in the training set nobody sees; scanned")
	ctx.Equal(len(result.Scanned["2026-10-02"]), 3, "the healthy partition's rows")
}

func CheckPermissionAbort(ctx *harness.Ctx) {
	peer := client(ctx)
	peer.failing["2026-10-02"] = codes.PermissionDenied
	result, err := backfill(clientBg, "amount_7d", 2, parts, cutoff)
	ctx.Assert(err != nil, "a refused scan must return an error wrapping ErrBackfillAborted; backfill returned %+v", result)
	ctx.ErrorIs(err, ErrBackfillAborted, "a refused scan returned %v", err)
	var asked []string
	for _, c := range ctx.GRPC.CallsTo("Scan", "") {
		asked = append(asked, c.Request.(*pb.ScanRequest).GetPartition())
	}
	ctx.Equal(asked, parts[:2], "after PERMISSION_DENIED on 2026-10-02 the backfill must stop; it scanned")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "feature_store.grpc.pb.h"

namespace {

constexpr long long kCutoff = 1790000000;
const std::vector<std::string> kParts = {"2026-10-01", "2026-10-02", "2026-10-03"};

// Two entities per partition, each with a value an hour before the cutoff and one an hour after; a
// third entity is null. A partition in failing fails with its code.
class OfflinePeer final : public featurestore::OfflineStore::Service {
 public:
  std::map<std::string, grpc::StatusCode> failing;
  grpc::Status Scan(grpc::ServerContext*, const featurestore::ScanRequest* req, featurestore::ScanResponse* out) override {
    const auto failure = failing.find(req->partition());
    if (failure != failing.end()) return grpc::Status(failure->second, "partition " + req->partition() + " failed");
    for (int i = 1; i <= 2; i++) {
      const bool late = req->as_of() == 0 || kCutoff + 3600 <= req->as_of();
      auto* row = out->add_rows();
      row->set_entity(req->partition() + "/e-" + std::to_string(i));
      row->set_value(late ? 99.0 : 10.0 * i);
      row->set_event_ts(late ? kCutoff + 3600 : kCutoff - 3600);
    }
    auto* null_row = out->add_rows();
    null_row->set_entity(req->partition() + "/e-3");
    null_row->set_is_null(true);
    null_row->set_event_ts(kCutoff - 3600);
    return grpc::Status::OK;
  }
};

OfflinePeer& client(harness::Ctx& ctx) {
  static OfflinePeer* peer = nullptr;
  delete peer;
  peer = new OfflinePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  backfill("amount_7d", 2, kParts, kCutoff);
  const auto calls = ctx.GRPC.CallsTo("Scan");
  ctx.Equal(calls.size(), 3, "three partitions must make one Scan call each; the calls");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Scan call carries no deadline: one stuck partition holds the whole backfill open");
    ctx.Assert(59.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 60.5, "a Scan call carries a %v s deadline, expected kDeadline = 60 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Scan", 600);
  const int64_t before = ctx.Clock.Now();
  backfill("amount_7d", 2, {kParts[0]}, kCutoff);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 61, "a partition the store took 600 s over held the backfill for %.0f s, expected at most the 60 s deadline", waited);
}

void CheckAsOfCutoff(harness::Ctx& ctx) {
  client(ctx);
  const BackfillResult result = backfill("amount_7d", 2, kParts, kCutoff);
  std::vector<long long> asked;
  for (const auto& c : ctx.GRPC.CallsTo("Scan")) asked.push_back(c.Request<featurestore::ScanRequest>().as_of());
  ctx.Equal(asked, {kCutoff, kCutoff, kCutoff}, "every Scan request must carry the training cutoff as as_of; they carried");
  for (const std::string& partition : kParts) {
    const auto found = result.scanned.find(partition);
    const std::vector<online::Row> rows = found == result.scanned.end() ? std::vector<online::Row>{} : found->second;
    ctx.Equal(rows.size(), 3, "partition %s must scan its three rows; the rows", partition);
    int nulls = 0;
    for (const auto& row : rows) {
      ctx.Assert(row.event_ts <= kCutoff, "%s was scanned from %d s after the training cutoff: the model would train on the future", row.entity, row.event_ts - kCutoff);
      if (!row.value) nulls++;
    }
    ctx.Equal(nulls, 1, "partition %s must keep its one null row with no value; the nulls", partition);
  }
}

void CheckMissingPartitions(harness::Ctx& ctx) {
  OfflinePeer& peer = client(ctx);
  peer.failing["2026-10-01"] = grpc::StatusCode::DEADLINE_EXCEEDED;
  peer.failing["2026-10-03"] = grpc::StatusCode::UNAVAILABLE;
  const BackfillResult result = backfill("amount_7d", 2, kParts, kCutoff);
  ctx.Equal(result.missing, {"2026-10-01", "2026-10-03"}, "two partitions failed (DEADLINE_EXCEEDED, UNAVAILABLE); missing");
  std::vector<std::string> scanned;
  for (const auto& [partition, rows] : result.scanned) scanned.push_back(partition);
  ctx.Equal(scanned, {"2026-10-02"}, "a failed partition reported as scanned and empty is a hole in the training set nobody sees; scanned");
  ctx.Equal(result.scanned.at("2026-10-02").size(), 3, "the healthy partition's rows");
}

void CheckPermissionAbort(harness::Ctx& ctx) {
  OfflinePeer& peer = client(ctx);
  peer.failing["2026-10-02"] = grpc::StatusCode::PERMISSION_DENIED;
  bool aborted = false;
  try {
    backfill("amount_7d", 2, kParts, kCutoff);
  } catch (const BackfillAborted&) {
    aborted = true;
  } catch (const std::exception& e) {
    ctx.Fatalf("a refused scan threw %s: %s, expected BackfillAborted", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(aborted, "a refused scan must throw BackfillAborted; backfill returned normally");
  std::vector<std::string> asked;
  for (const auto& c : ctx.GRPC.CallsTo("Scan")) asked.push_back(c.Request<featurestore::ScanRequest>().partition());
  ctx.Equal(asked, {kParts[0], kParts[1]}, "after PERMISSION_DENIED on 2026-10-02 the backfill must stop; it scanned");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps");
}
`,
  },
  hints: [
    'Make one partition slow: the backfill waits ten minutes for it. Train on the result: some values are from after the cutoff. A partition that timed out shows up in scanned, with no rows.',
    'The Scan has no deadline and its request never sets as_of, so the store answers its newest values. The except turns every status code into an empty partition, a refusal included, and the loop moves on.',
    'Pass `timeout=DEADLINE_S` (60) and `as_of=as_of`; in the except, raise `BackfillAborted` on `PERMISSION_DENIED`, otherwise append the partition to `missing` and leave it out of `scanned`.',
  ],
  debrief: `The status code carries the decision: a timeout says nothing about the data, so the partition is missing and a later run scans it again, while a refusal says the job itself is wrong, so it stops before it spends warehouse capacity on partitions it could not read either. The cutoff belongs in the request because the offline store is where point-in-time correctness is decided: a point-in-time join picks, for every entity, the newest value at or before the training timestamp, and a scan without one answers with today's values. Production backfills also run partitions in parallel under a concurrency limit and checkpoint the partitions done, so a rerun only scans what is missing.`,
};
