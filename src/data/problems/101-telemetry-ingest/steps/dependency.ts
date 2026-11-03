import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Time-series writes with batch-scoped retries',
  concept: 'grpc',
  file: 'client',
  focus: ['ingest', 'tsdb'],
  task: `## Task

**Starting point.** The starter implements \`write_batch(stub, batch)\`, the ingest path's
time-series client: in a \`while True\` loop it builds a \`WriteRequest\` from every sub-batch, calls
\`Write\` with no deadline, and returns \`complete: True\` as soon as the reply names any accepted
sub-batch. When the store is healthy the demo shows points arriving. It hides five flaws.

**Failure mode the checks target.** A fleet's totals double, because sub-batches the store already
accepted are sent again and the store does not dedupe by point. A batch is reported done while some
of its points are still missing, so the caller stops looking. A stuck store pins the ingest worker
until the client disconnects, and a store that keeps failing turns the worker into a hot loop. And no
request carries a batch id, so the store has nothing to dedupe on even when it wants to.

- Each attempt carries a **4-second deadline** (\`DEADLINE_S = 4.0\`, \`timeout=\`).
- At most \`MAX_ATTEMPTS = 3\` attempts in a counted loop; no \`while True\`.
- The reply is partial: it names the accepted and the failed sub-batches. Only the failed ones go
  into the next request (\`pending\` becomes its intersection with \`reply.failed\`), and accepted
  ids are appended to the result.
- Every attempt carries the same \`batch_id\` (\`batch_id=batch["batch_id"]\`), the key the store
  dedupes on.
- The batch is complete only when the reply names no failed sub-batch (\`if not reply.failed\`).`,
  sequence: {
    participants: ['Telemetry Ingest', 'Time-series store'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'Time-series store',
        label: 'Write · batch_id · sub-batches[0..n] · deadline 4 s',
        kind: 'sync',
      },
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'WriteReply{accepted[], failed[]}', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'pending = pending ∩ failed · same batch_id',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Time-series store', label: 'Write · only the failed sub-batches', kind: 'sync'},
      {
        from: 'Time-series store',
        to: 'Telemetry Ingest',
        label: 'accepted — accepted sub-batches never re-sent',
        kind: 'reply',
      },
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'complete only when failed is empty',
        kind: 'sync',
      },
    ],
  },
  hints: [
    "After a brief store slowdown, a fleet's daily totals read roughly double, and a few devices show gaps for batches the pipeline reported as complete.",
    'The loop re-adds every sub-batch to each request, so accepted points are stored again; `if len(reply.accepted) > 0` returns complete while `reply.failed` is non-empty; `stub.Write(request)` has no timeout and the loop has no exit.',
    'Keep `pending`, replace it with `[sub for sub in pending if sub["id"] in rejected]` after each reply, send `batch_id` on every request, call `Write(..., timeout=DEADLINE_S)` inside `range(MAX_ATTEMPTS)`, and return complete only `if not reply.failed`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 4-second deadline',
      detail:
        'The call is created with a 4-second deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `deadline: Date.now() + DEADLINE_MS` or `set_deadline`. Without it a stuck store holds the ingest worker open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*4\.0/, /timeout=DEADLINE_S/, /\.Write\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*4000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Write\(/]},
        go: {all: [/deadlineMS\s*=\s*4000/, /context\.WithTimeout/, /\.Write\(/]},
        scala: {all: [/DeadlineMs\s*=\s*4000/, /withDeadlineAfter/, /\.write\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*4000/, /set_deadline\(/, /->Write\(/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most three attempts, never an unbounded loop',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and the loop counts. The starter loops forever while the store keeps failing, so an outage turns every ingest worker into a hot loop against a store that is already down.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /range\(MAX_ATTEMPTS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /attempt\s*<\s*kMaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'failed-only',
      title: 'Retries only the sub-batches the store rejected',
      detail:
        'The next request is built from the reply’s failed list — the pending set is replaced by its intersection with `failed`/`Failed` — so an accepted sub-batch is never sent twice. The starter re-sends the whole batch on every failure, which doubles the points the store already stored.',
      match: {
        python: {all: [/reply\.failed/, /pending = \[sub for sub in pending if sub\["id"\] in rejected\]/]},
        typescript: {all: [/reply\.failed/, /pending = pending\.filter\(sub => rejected\.has\(sub\.id\)\)/]},
        go: {all: [/reply\.Failed/, /if rejected\[sub\.ID\]\s*\{/]},
        scala: {all: [/reply\.failed/, /pending = pending\.filter\(sub => rejected\.contains\(sub\.id\)\)/]},
        cpp: {all: [/reply\.failed\(\)/, /if \(rejected\.count\(sub\.id\) > 0\)/]},
      },
    },
    {
      id: 'done-all',
      title: 'Done only when every sub-batch is stored',
      detail:
        'The batch is reported complete only when the reply names no failed sub-batches. The starter returns complete as soon as any sub-batch was accepted, so the caller believes a partial write is a finished batch.',
      match: {
        python: {all: [/if not reply\.failed/, /"complete": True/], none: [/if len\(reply\.accepted\)/]},
        typescript: {
          all: [/reply\.failed\.length\s*===\s*0/, /complete: true/],
          none: [/if \(reply\.accepted\.length > 0\)/],
        },
        go: {all: [/len\(reply\.Failed\)\s*==\s*0/, /Complete:\s*true/], none: [/len\(reply\.Accepted\)\s*>\s*0/]},
        scala: {all: [/reply\.failed\.isEmpty/, /complete = true/], none: [/reply\.accepted\.nonEmpty/]},
        cpp: {
          all: [/reply\.failed\(\)\.empty\(\)/, /, true\}/],
          none: [/reply\.accepted_size\(\) > 0/],
        },
      },
    },
    {
      id: 'batch-id',
      title: 'Every attempt carries the same batch id',
      detail:
        'Each request carries the caller’s `batch_id` (the store’s dedupe key) and the accepted sub-batches are appended to the result rather than re-queued. The starter sends no batch id, so a re-sent sub-batch has nothing to dedupe against.',
      match: {
        python: {all: [/batch_id=batch\["batch_id"\]/, /accepted\.extend\(reply\.accepted\)/]},
        typescript: {all: [/batch_id: batch\.batch_id/, /accepted\.push\(\.\.\.reply\.accepted\)/]},
        go: {all: [/BatchId:\s*batch\.BatchID/, /accepted = append\(accepted, reply\.Accepted\.\.\.\)/]},
        scala: {all: [/batchId = batch\.batchId/, /accepted \+\+= reply\.accepted/]},
        cpp: {
          all: [
            /set_batch_id\(batch\.batch_id\)/,
            /accepted\.insert\(accepted\.end\(\), reply\.accepted\(\)\.begin\(\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import series_pb2
import series_pb2_grpc


def write_batch(stub: series_pb2_grpc.SeriesStub, batch: dict) -> dict:
    """Write a batch of sub-batches to the time-series store."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        request = series_pb2.WriteRequest(device_id=batch["device_id"])
        for sub in batch["sub_batches"]:
            request.sub_batches.add(id=sub["id"], points=sub["points"])
        reply = stub.Write(request)
        if len(reply.accepted) > 0:
            return {
                "batch_id": batch["batch_id"],
                "accepted": list(reply.accepted),
                "failed": [],
                "complete": True,
            }
`,
      solution: `import grpc

import series_pb2
import series_pb2_grpc

DEADLINE_S = 4.0
MAX_ATTEMPTS = 3


def write_batch(stub: series_pb2_grpc.SeriesStub, batch: dict) -> dict:
    """Write a batch, retrying only the sub-batches the store did not accept."""
    pending = list(batch["sub_batches"])
    accepted: list[str] = []
    for _ in range(MAX_ATTEMPTS):
        request = series_pb2.WriteRequest(batch_id=batch["batch_id"], device_id=batch["device_id"])
        for sub in pending:
            request.sub_batches.add(id=sub["id"], points=sub["points"])
        reply = stub.Write(request, timeout=DEADLINE_S)
        accepted.extend(reply.accepted)
        if not reply.failed:
            return {
                "batch_id": batch["batch_id"],
                "accepted": accepted,
                "failed": [],
                "complete": True,
            }
        # Only the rejected sub-batches go into the next attempt, under the same batch id: the store
        # dedupes on (batch_id, sub-batch id), so a re-sent sub-batch is free and an accepted one is
        # never sent twice.
        rejected = set(reply.failed)
        pending = [sub for sub in pending if sub["id"] in rejected]
    return {
        "batch_id": batch["batch_id"],
        "accepted": accepted,
        "failed": [sub["id"] for sub in pending],
        "complete": False,
    }
`,
    },
    typescript: {
      starter: `/** Time-series writes: flawed code that re-sends the whole batch on failure. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const {series} = grpc.loadPackageDefinition(protoLoader.loadSync('series.proto')) as unknown as {
  series: {Series: new (target: string, credentials: grpc.ChannelCredentials) => SeriesClient};
};
const client = new series.Series('tsdb:9000', grpc.credentials.createInsecure());

interface SubBatch {
  id: string;
  points: {ts: number; value: number}[];
}

interface Batch {
  batch_id: string;
  device_id: string;
  sub_batches: SubBatch[];
}

interface WriteReply {
  accepted: string[];
  failed: string[];
}

interface WriteResult {
  batch_id: string;
  accepted: string[];
  failed: string[];
  complete: boolean;
}

interface SeriesClient {
  Write(
    request: {device_id: string; sub_batches: SubBatch[]},
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, reply: WriteReply) => void,
  ): void;
}

export async function writeBatch(batch: Batch): Promise<WriteResult> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (;;) {
    const reply = await new Promise<WriteReply>((resolve, reject) => {
      client.Write({device_id: batch.device_id, sub_batches: batch.sub_batches}, new grpc.Metadata(), (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    if (reply.accepted.length > 0)
      return {batch_id: batch.batch_id, accepted: reply.accepted, failed: [], complete: true};
  }
}
`,
      solution: `/** Time-series writes: a 4 s deadline per attempt, retries scoped to the failed sub-batches. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const {series} = grpc.loadPackageDefinition(protoLoader.loadSync('series.proto')) as unknown as {
  series: {Series: new (target: string, credentials: grpc.ChannelCredentials) => SeriesClient};
};
const client = new series.Series('tsdb:9000', grpc.credentials.createInsecure());

const DEADLINE_MS = 4000;
const MAX_ATTEMPTS = 3;

interface SubBatch {
  id: string;
  points: {ts: number; value: number}[];
}

interface Batch {
  batch_id: string;
  device_id: string;
  sub_batches: SubBatch[];
}

interface WriteReply {
  accepted: string[];
  failed: string[];
}

interface WriteResult {
  batch_id: string;
  accepted: string[];
  failed: string[];
  complete: boolean;
}

interface SeriesClient {
  Write(
    request: {batch_id: string; device_id: string; sub_batches: SubBatch[]},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: WriteReply) => void,
  ): void;
}

export async function writeBatch(batch: Batch): Promise<WriteResult> {
  let pending = [...batch.sub_batches];
  const accepted: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request = {
      batch_id: batch.batch_id,
      device_id: batch.device_id,
      sub_batches: pending,
    };
    const reply = await new Promise<WriteReply>((resolve, reject) => {
      client.Write(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    accepted.push(...reply.accepted);
    if (reply.failed.length === 0)
      return {batch_id: batch.batch_id, accepted, failed: [], complete: true};
    // Only the rejected sub-batches go into the next attempt, under the same batch id: the store
    // dedupes on (batch_id, sub-batch id), so a re-sent sub-batch is free and an accepted one is
    // never sent twice.
    const rejected = new Set(reply.failed);
    pending = pending.filter(sub => rejected.has(sub.id));
  }
  return {batch_id: batch.batch_id, accepted, failed: pending.map(sub => sub.id), complete: false};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "ingest/seriespb"
)

type SubBatch struct {
	ID     string
	Points []*pb.Point
}

type Batch struct {
	BatchID    string
	DeviceID   string
	SubBatches []SubBatch
}

type WriteResult struct {
	BatchID  string
	Accepted []string
	Failed   []string
	Complete bool
}

func writeBatch(ctx context.Context, client pb.SeriesClient, batch Batch) (*WriteResult, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		request := &pb.WriteRequest{DeviceId: batch.DeviceID}
		for _, sub := range batch.SubBatches {
			request.SubBatches = append(request.SubBatches, &pb.SubBatch{Id: sub.ID, Points: sub.Points})
		}
		reply, err := client.Write(ctx, request)
		if err != nil {
			continue
		}
		if len(reply.Accepted) > 0 {
			return &WriteResult{BatchID: batch.BatchID, Accepted: reply.Accepted, Complete: true}, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	pb "ingest/seriespb"
)

const (
	deadlineMS  = 4000
	maxAttempts = 3
)

type SubBatch struct {
	ID     string
	Points []*pb.Point
}

type Batch struct {
	BatchID    string
	DeviceID   string
	SubBatches []SubBatch
}

type WriteResult struct {
	BatchID  string
	Accepted []string
	Failed   []string
	Complete bool
}

// writeBatch writes a batch of sub-batches under one deadline per attempt, retrying only the parts
// the store did not accept.
func writeBatch(ctx context.Context, client pb.SeriesClient, batch Batch) (*WriteResult, error) {
	pending := append([]SubBatch(nil), batch.SubBatches...)
	accepted := []string{}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		request := &pb.WriteRequest{BatchId: batch.BatchID, DeviceId: batch.DeviceID}
		for _, sub := range pending {
			request.SubBatches = append(request.SubBatches, &pb.SubBatch{Id: sub.ID, Points: sub.Points})
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := client.Write(callCtx, request)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("write batch %s: %w", batch.BatchID, err)
		}
		accepted = append(accepted, reply.Accepted...)
		if len(reply.Failed) == 0 {
			return &WriteResult{BatchID: batch.BatchID, Accepted: accepted, Complete: true}, nil
		}
		// Only the rejected sub-batches go into the next attempt, under the same batch id: the store
		// dedupes on (batch_id, sub-batch id), so a re-sent sub-batch is free and an accepted one is
		// never sent twice.
		rejected := map[string]bool{}
		for _, id := range reply.Failed {
			rejected[id] = true
		}
		next := []SubBatch{}
		for _, sub := range pending {
			if rejected[sub.ID] {
				next = append(next, sub)
			}
		}
		pending = next
	}
	failed := []string{}
	for _, sub := range pending {
		failed = append(failed, sub.ID)
	}
	return &WriteResult{BatchID: batch.BatchID, Accepted: accepted, Failed: failed, Complete: false}, nil
}
`,
    },
    scala: {
      starter: `object TimeSeriesClient {
  def writeBatch(client: SeriesClient.SeriesBlockingStub, batch: Batch): WriteResult = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    var done = false
    var result = WriteResult(batch.batchId, Nil, Nil, complete = false)
    while (!done) {
      val request = WriteRequest(deviceId = batch.deviceId, subBatches = batch.subBatches)
      val reply = client.write(request)
      if (reply.accepted.nonEmpty) {
        result = WriteResult(batch.batchId, reply.accepted, Nil, complete = true)
        done = true
      }
    }
    result
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

object TimeSeriesClient {
  val DeadlineMs = 4000L
  val MaxAttempts = 3

  def writeBatch(client: SeriesClient.SeriesBlockingStub, batch: Batch): WriteResult = {
    var pending = batch.subBatches
    val accepted = scala.collection.mutable.ArrayBuffer.empty[String]
    var attempt = 0
    var result: Option[WriteResult] = None
    while (attempt < MaxAttempts && result.isEmpty) {
      val request = WriteRequest(batchId = batch.batchId, deviceId = batch.deviceId, subBatches = pending)
      val reply = client.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).write(request)
      accepted ++= reply.accepted
      if (reply.failed.isEmpty) {
        result = Some(WriteResult(batch.batchId, accepted.toList, Nil, complete = true))
      } else {
        // Only the rejected sub-batches go into the next attempt, under the same batch id: the store
        // dedupes on (batch_id, sub-batch id), so a re-sent sub-batch is free and an accepted one is
        // never sent twice.
        val rejected = reply.failed.toSet
        pending = pending.filter(sub => rejected.contains(sub.id))
      }
      attempt += 1
    }
    result.getOrElse(WriteResult(batch.batchId, accepted.toList, pending.map(_.id), complete = false))
  }
}
`,
    },
    cpp: {
      starter: `#include "series.grpc.pb.h"

#include <string>
#include <vector>

struct SubBatch {
  std::string id;
  std::vector<Point> points;
};

struct Batch {
  std::string batch_id;
  std::string device_id;
  std::vector<SubBatch> sub_batches;
};

struct WriteResult {
  std::string batch_id;
  std::vector<std::string> accepted;
  std::vector<std::string> failed;
  bool complete;
};

WriteResult writeBatch(Series::Stub* stub, const Batch& batch) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  while (true) {
    grpc::ClientContext ctx;
    WriteRequest request;
    request.set_device_id(batch.device_id);
    for (const auto& sub : batch.sub_batches) {
      auto* wire = request.add_sub_batches();
      wire->set_id(sub.id);
      for (const auto& point : sub.points) *wire->add_points() = point;
    }
    WriteReply reply;
    if (!stub->Write(&ctx, request, &reply).ok()) continue;
    if (reply.accepted_size() > 0) {
      return WriteResult{batch.batch_id, {reply.accepted().begin(), reply.accepted().end()}, {}, true};
    }
  }
}
`,
      solution: `#include "series.grpc.pb.h"

#include <chrono>
#include <set>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 4000;
constexpr int kMaxAttempts = 3;

struct SubBatch {
  std::string id;
  std::vector<Point> points;
};

struct Batch {
  std::string batch_id;
  std::string device_id;
  std::vector<SubBatch> sub_batches;
};

struct WriteResult {
  std::string batch_id;
  std::vector<std::string> accepted;
  std::vector<std::string> failed;
  bool complete;
};

WriteResult writeBatch(Series::Stub* stub, const Batch& batch) {
  std::vector<SubBatch> pending = batch.sub_batches;
  std::vector<std::string> accepted;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    WriteRequest request;
    request.set_batch_id(batch.batch_id);
    request.set_device_id(batch.device_id);
    for (const auto& sub : pending) {
      auto* wire = request.add_sub_batches();
      wire->set_id(sub.id);
      for (const auto& point : sub.points) *wire->add_points() = point;
    }
    WriteReply reply;
    if (!stub->Write(&ctx, request, &reply).ok()) break;
    accepted.insert(accepted.end(), reply.accepted().begin(), reply.accepted().end());
    if (reply.failed().empty()) return WriteResult{batch.batch_id, accepted, {}, true};
    // Only the rejected sub-batches go into the next attempt, under the same batch id: the store
    // dedupes on (batch_id, sub-batch id), so a re-sent sub-batch is free and an accepted one is
    // never sent twice.
    const std::set<std::string> rejected(reply.failed().begin(), reply.failed().end());
    std::vector<SubBatch> next;
    for (const auto& sub : pending) {
      if (rejected.count(sub.id) > 0) next.push_back(sub);
    }
    pending = next;
  }
  std::vector<std::string> failed;
  for (const auto& sub : pending) {
    failed.push_back(sub.id);
  }
  return WriteResult{batch.batch_id, accepted, failed, false};
}
`,
    },
  },
  debrief: `Retrying a partial write is not retrying the batch, and the fix follows from that distinction. The store answers with the sub-batches it took and the ones it did not, so the client keeps a pending set and shrinks it to the reply's failed list after every attempt; accepted points are already stored, and sending them again is a duplicate the store cannot notice. One batch id across every attempt makes the retry safe by construction, because the store can drop a sub-batch it has already seen under that id. Completing only when nothing is left failed matters because a batch reported done with a missing sub-batch is worse than one that never landed: the caller has stopped looking. The deadline and the attempt cap keep a store outage from becoming an ingest outage. Production clients add jittered backoff and a reconciliation pass for batches whose outcome was never known.`,
};
