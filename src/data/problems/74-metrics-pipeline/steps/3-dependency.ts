import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Shard-writer calls with per-shard acknowledgments',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'shards'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it fans the flush out to every
shard, retries all of them after any failure and answers with one success bit. It compiles, it passes
the demo because every shard is healthy and the first attempt lands, and it hides a double count, a
retry storm and a lost window. Review it like the owner of the flush path, fix it, and prove the fix
with the checks below.

Windows aggregated in the window store are flushed to the shard writers over **gRPC** with
\`MetricsWriter.WriteWindows\`:

- Each shard gets its own call carrying its own **2-second** deadline: one \`FLUSH_DEADLINE_MS = 2000\`
  constant, passed as the deadline of that call. A shard that hangs must fail on its own instead of
  holding the whole flush past its budget.
- The flush returns **which shards accepted which windows**: a result keyed by shard whose value is
  the window ids that shard took, plus what is still pending. One boolean for the whole flush cannot
  say who is missing what.
- A retry re-sends **only the shards that did not answer accepted**. A shard that accepted is never
  asked again, and a window a shard already took is never sent to it a second time.
- A partial flush is **visible and resumable**: the result carries the still-pending windows per
  shard, so the caller resumes them on the next tick instead of dropping them.
- Every window is identified by a **window id** (\`{series}@{boundary}\`) and the request asks the
  shard to \`dedupe_by_window_id\`, so a window that races a retry is counted exactly once.
- The flush is complete only when every shard has accepted every window it owns. One shard's
  snippet succeeding is not completion.

**Failure mode the checks target.** The draft loops every shard on every attempt and collapses the
answers into one boolean. So a single failed shard re-sends windows the other shards already
accepted — the rollup double-counts a minute that was already written — and a flush where one shard
succeeded is reported as complete, so the windows nobody accepted are dropped and the minute quietly
under-counts. Sending windows as bare values is what makes the retry unsalvageable: without an id
the shard cannot tell a replay from a new window.`,
  sequence: {
    participants: ['Minute loop', 'Metrics API', 'Shard writers'],
    messages: [
      {from: 'Minute loop', to: 'Metrics API', label: 'flush boundary 1719… · windows by shard', kind: 'sync'},
      {
        from: 'Metrics API',
        to: 'Shard writers',
        label: 'WriteWindows(window ids) · deadline 2 s per shard',
        kind: 'sync',
      },
      {
        from: 'Shard writers',
        to: 'Metrics API',
        label: '{shard: accepted window ids} · not one success bit',
        kind: 'reply',
      },
      {
        from: 'Metrics API',
        to: 'Shard writers',
        label: 'retry only the failed shards · same window ids, dedupe by id',
        kind: 'sync',
      },
      {from: 'Metrics API', to: 'Minute loop', label: 'accepted per shard · pending windows to resume', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every shard call carries its own 2-second deadline',
      detail:
        'Each `WriteWindows` goes out with a deadline taken from one constant — `FLUSH_DEADLINE_MS = 2000` — so a hung shard fails alone. The draft sends every call with no deadline at all, so one stuck shard holds the flush until the caller gives up.',
      match: {
        python: {all: [/FLUSH_DEADLINE_MS = 2000/, /timeout=FLUSH_DEADLINE_MS \/ 1000/]},
        typescript: {all: [/FLUSH_DEADLINE_MS = 2000/, /deadline: Date\.now\(\) \+ FLUSH_DEADLINE_MS/]},
        go: {
          all: [
            /flushDeadlineMs\s*=\s*2000/,
            /context\.WithTimeout\(ctx, time\.Duration\(flushDeadlineMs\)\*time\.Millisecond\)/,
          ],
        },
        scala: {
          all: [/FlushDeadlineMs(?::\s*Long)? = 2000/, /withDeadlineAfter\(FlushDeadlineMs, TimeUnit\.MILLISECONDS\)/],
        },
        cpp: {
          all: [
            /kFlushDeadlineMs = 2000/,
            /set_deadline\(std::chrono::system_clock::now\(\) \+ std::chrono::milliseconds\(kFlushDeadlineMs\)\)/,
          ],
        },
      },
    },
    {
      id: 'per-shard-result',
      title: 'The flush reports which shards accepted which windows',
      detail:
        'The result is keyed by shard and carries the accepted window ids, not a single success boolean. The draft returns one bit, so a partial flush is indistinguishable from a complete one and nothing can be resumed.',
      match: {
        python: {all: [/accepted_by_shard/, /dict\[str, list\[str\]\]/], none: [/-> bool\b/]},
        typescript: {all: [/acceptedByShard/, /Record<string, string\[\]>/], none: [/Promise<boolean>/]},
        go: {all: [/AcceptedByShard/, /map\[string\]\[\]string/], none: [/\) bool \{/]},
        scala: {all: [/acceptedByShard/, /Map\[String, Seq\[String\]\]/], none: [/\): Boolean = \{/]},
        cpp: {
          all: [/accepted_by_shard/, /std::map<std::string, std::vector<std::string>>/],
          none: [/static bool flush_windows/],
        },
      },
    },
    {
      id: 'retry-failed-only',
      title: 'Retries iterate only the failed shards',
      detail:
        'The retry loop is driven by the set of shards that did not answer accepted, and a shard leaves that set once it accepts — so an accepted window is never sent twice. The draft loops every shard on every attempt, which is how a healthy shard gets a window it already counted.',
      match: {
        python: {
          all: [/failed = dict\(windows\)/, /for shard in sorted\(failed\)/],
          none: [/for shard in SHARD_WRITERS/],
        },
        typescript: {
          all: [/const failed: Record<string, string\[\]> = \{\.\.\.windows\}/, /Object\.keys\(failed\)\.sort\(\)/],
          none: [/for \(const shard of SHARD_WRITERS\)/],
        },
        go: {all: [/failed := maps\.Clone\(windows\)/, /sort\.Strings\(shards\)/], none: [/range shardWriters/]},
        scala: {
          all: [/var failed = windows/, /failed\.keys\.toSeq\.sorted/],
          none: [/for \(shard <- ShardWriters\.keys\)/],
        },
        cpp: {
          all: [/auto failed = windows;/, /for \(auto it = failed\.begin\(\)/],
          none: [/for \(const auto& \[shard, stub\] : stubs\)/],
        },
      },
    },
    {
      id: 'partial-resumable',
      title: 'A partial flush is visible and resumable',
      detail:
        'Whatever the shards did not accept comes back as pending windows per shard, which is what the caller resumes on the next tick. The draft marks the flush complete the moment one shard’s snippet succeeds, so the unaccepted windows are lost.',
      match: {
        python: {all: [/result\.pending_by_shard\[shard\] = pending/], none: [/\breturn True\b/]},
        typescript: {all: [/result\.pendingByShard\[shard\] = failed\[shard\]/], none: [/\breturn true;/]},
        go: {all: [/result\.PendingByShard\[shard\] = pending/], none: [/\breturn true\b/]},
        scala: {all: [/FlushResult\(acceptedByShard\.toMap, failed\)/, /pendingByShard/], none: [/\breturn true\b/]},
        cpp: {all: [/result\.pending_by_shard = failed;/, /return result;/], none: [/bool ok = false;/]},
      },
    },
    {
      id: 'window-id-idempotent',
      title: 'Windows carry an id the shard can dedupe by',
      detail:
        'Each window travels as a window id (`{series}@{boundary}`) and the request sets `dedupe_by_window_id`, so an accepted window that races a retry is a no-op at the shard. The draft sends bare values with no id, so a re-sent window is counted twice.',
      match: {
        python: {all: [/dedupe_by_window_id=True/, /window_ids/], none: [/windows=windows\[shard\]/]},
        typescript: {all: [/dedupeByWindowId: true/, /windowIds/], none: [/windows: windows\[shard\]/]},
        go: {all: [/DedupeByWindowId:\s*true/, /WindowIds:\s*windowIDs/], none: [/Windows:\s+windows\[shard\]/]},
        scala: {all: [/setDedupeByWindowId\(true\)/, /windowIds/], none: [/addAllWindows\(/]},
        cpp: {all: [/set_dedupe_by_window_id\(true\)/, /window_ids/], none: [/add_windows\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import metrics_pb2
import metrics_pb2_grpc

SHARD_WRITERS = ["shard-a", "shard-b", "shard-c"]
RETRIES = 2


def flush_windows(channels, boundary: int, windows: dict[str, list[str]]) -> bool:
    # TODO: this draft retries every shard after any failure, sends windows without an id and
    # reports one success bit, so a retry re-sends accepted windows and a partial flush looks
    # complete.
    for _ in range(RETRIES + 1):
        ok = False
        for shard in SHARD_WRITERS:
            stub = metrics_pb2_grpc.MetricsWriterStub(channels[shard])
            request = metrics_pb2.WriteRequest(shard=shard, boundary=boundary, windows=windows[shard])
            try:
                reply = stub.WriteWindows(request)
                ok = ok or bool(reply.accepted)
            except grpc.RpcError:
                continue
        if ok:
            return True
    return False
`,
      solution: `import grpc

import metrics_pb2
import metrics_pb2_grpc

FLUSH_DEADLINE_MS = 2000
MAX_ATTEMPTS = 3


class FlushResult:
    """accepted_by_shard[shard] are the window ids the shard took; pending_by_shard is the resume set."""

    def __init__(self) -> None:
        self.accepted_by_shard: dict[str, list[str]] = {}
        self.pending_by_shard: dict[str, list[str]] = {}


def write_shard(stub, shard: str, boundary: int, window_ids: list[str]) -> tuple[list[str], list[str]]:
    """One shard, one deadline, one dedupe key: a replayed window id is a no-op at the shard."""
    request = metrics_pb2.WriteRequest(
        shard=shard,
        boundary=boundary,
        window_ids=window_ids,
        dedupe_by_window_id=True,
    )
    reply = stub.WriteWindows(request, timeout=FLUSH_DEADLINE_MS / 1000)
    return list(reply.accepted_window_ids), list(reply.rejected_window_ids)


def flush_windows(channels, boundary: int, windows: dict[str, list[str]]) -> FlushResult:
    """Flush every shard, then retry only the shards that failed — never a window already accepted."""
    result = FlushResult()
    failed = dict(windows)
    for _ in range(MAX_ATTEMPTS):
        if not failed:
            break
        for shard in sorted(failed):
            stub = metrics_pb2_grpc.MetricsWriterStub(channels[shard])
            try:
                accepted, rejected = write_shard(stub, shard, boundary, failed[shard])
            except grpc.RpcError:
                continue
            result.accepted_by_shard.setdefault(shard, []).extend(accepted)
            if rejected:
                failed[shard] = rejected
            else:
                failed.pop(shard)
    for shard, pending in failed.items():
        result.pending_by_shard[shard] = pending
    return result
`,
    },
    typescript: {
      starter: `import type {ServiceError} from '@grpc/grpc-js';

const SHARD_WRITERS = ['shard-a', 'shard-b', 'shard-c'];
const RETRIES = 2;

interface WriteRequest {
  shard: string;
  boundary: number;
  windows: string[];
}

interface WriteReply {
  accepted: boolean;
}

interface MetricsWriterStub {
  WriteWindows(request: WriteRequest, callback: (err: ServiceError | null, reply: WriteReply) => void): void;
}

export async function flushWindows(
  stubs: Record<string, MetricsWriterStub>,
  boundary: number,
  windows: Record<string, string[]>,
): Promise<boolean> {
  // TODO: this draft retries every shard after any failure, sends windows without an id and
  // reports one success bit, so a retry re-sends accepted windows and a partial flush looks complete.
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let ok = false;
    for (const shard of SHARD_WRITERS) {
      try {
        const {promise, resolve, reject} = Promise.withResolvers<WriteReply>();
        stubs[shard].WriteWindows({shard, boundary, windows: windows[shard]}, (err, reply) => {
          if (err) reject(err);
          else resolve(reply);
        });
        const reply = await promise;
        ok = ok || reply.accepted;
      } catch {
        continue;
      }
    }
    if (ok) return true;
  }
  return false;
}
`,
      solution: `import type {ServiceError} from '@grpc/grpc-js';

const FLUSH_DEADLINE_MS = 2000;
const MAX_ATTEMPTS = 3;

interface WriteRequest {
  shard: string;
  boundary: number;
  windowIds: string[];
  dedupeByWindowId: boolean;
}

interface WriteReply {
  acceptedWindowIds: string[];
  rejectedWindowIds: string[];
}

interface WriteOptions {
  deadline: number;
}

interface MetricsWriterStub {
  WriteWindows(
    request: WriteRequest,
    options: WriteOptions,
    callback: (err: ServiceError | null, reply: WriteReply) => void,
  ): void;
}

interface ShardReply {
  accepted: string[];
  rejected: string[];
}

interface FlushResult {
  acceptedByShard: Record<string, string[]>;
  pendingByShard: Record<string, string[]>;
}

function writeShard(
  stub: MetricsWriterStub,
  shard: string,
  boundary: number,
  windowIds: string[],
): Promise<ShardReply> {
  // One shard, one deadline, one dedupe key: a replayed window id is a no-op at the shard.
  const {promise, resolve, reject} = Promise.withResolvers<ShardReply>();
  stub.WriteWindows(
    {shard, boundary, windowIds, dedupeByWindowId: true},
    {deadline: Date.now() + FLUSH_DEADLINE_MS},
    (err, reply) => {
      if (err) reject(err);
      else resolve({accepted: reply.acceptedWindowIds, rejected: reply.rejectedWindowIds});
    },
  );
  return promise;
}

export async function flushWindows(
  stubs: Record<string, MetricsWriterStub>,
  boundary: number,
  windows: Record<string, string[]>,
): Promise<FlushResult> {
  const result: FlushResult = {acceptedByShard: {}, pendingByShard: {}};
  const failed: Record<string, string[]> = {...windows};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shards = Object.keys(failed).sort();
    if (shards.length === 0) break;
    for (const shard of shards) {
      try {
        const reply = await writeShard(stubs[shard], shard, boundary, failed[shard]);
        result.acceptedByShard[shard] = [...(result.acceptedByShard[shard] ?? []), ...reply.accepted];
        if (reply.rejected.length === 0) delete failed[shard];
        else failed[shard] = reply.rejected;
      } catch {
        continue;
      }
    }
  }
  for (const shard of Object.keys(failed)) result.pendingByShard[shard] = failed[shard];
  return result;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "metrics/proto"
)

const retries = 2

var shardWriters = map[string]string{"shard-a": "shard-a:9090", "shard-b": "shard-b:9090"}

// flushWindows sends the boundary to every shard, retries all of them after any failure and
// answers with one success bit.
func flushWindows(ctx context.Context, boundary int64, windows map[string][]string) bool {
	// TODO: this draft retries every shard after any failure, sends windows without an id and
	// reports one success bit, so a retry re-sends accepted windows and a partial flush looks
	// complete.
	for attempt := 0; attempt <= retries; attempt++ {
		ok := false
		for shard, addr := range shardWriters {
			conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
			if err != nil {
				continue
			}
			reply, err := pb.NewMetricsWriterClient(conn).WriteWindows(ctx, &pb.WriteRequest{
				Shard:    shard,
				Boundary: boundary,
				Windows:  windows[shard],
			})
			if err == nil && reply.GetAccepted() {
				ok = true
			}
		}
		if ok {
			return true
		}
	}
	return false
}
`,
      solution: `package main

import (
	"context"
	"maps"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "metrics/proto"
)

const (
	flushDeadlineMs = 2000
	maxAttempts     = 3
)

var shardWriters = map[string]string{"shard-a": "shard-a:9090", "shard-b": "shard-b:9090"}

type ShardReply struct {
	Accepted []string
	Rejected []string
}

// FlushResult answers for the whole flush: which shard took which window id, and what is still pending.
type FlushResult struct {
	AcceptedByShard map[string][]string
	PendingByShard  map[string][]string
}

func writeShard(ctx context.Context, client pb.MetricsWriterClient, shard string, boundary int64, windowIDs []string) (*ShardReply, error) {
	// The deadline belongs to this shard's call, not to the flush.
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(flushDeadlineMs)*time.Millisecond)
	defer cancel()
	reply, err := client.WriteWindows(callCtx, &pb.WriteRequest{
		Shard:            shard,
		Boundary:         boundary,
		WindowIds:        windowIDs,
		DedupeByWindowId: true,
	})
	if err != nil {
		return nil, err
	}
	return &ShardReply{Accepted: reply.GetAcceptedWindowIds(), Rejected: reply.GetRejectedWindowIds()}, nil
}

func flushWindows(ctx context.Context, boundary int64, windows map[string][]string) *FlushResult {
	result := &FlushResult{AcceptedByShard: map[string][]string{}, PendingByShard: map[string][]string{}}
	failed := maps.Clone(windows)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if len(failed) == 0 {
			break
		}
		shards := make([]string, 0, len(failed))
		for shard := range failed {
			shards = append(shards, shard)
		}
		sort.Strings(shards)
		for _, shard := range shards {
			conn, err := grpc.NewClient(shardWriters[shard], grpc.WithTransportCredentials(insecure.NewCredentials()))
			if err != nil {
				continue
			}
			reply, err := writeShard(ctx, pb.NewMetricsWriterClient(conn), shard, boundary, failed[shard])
			if err != nil {
				continue
			}
			result.AcceptedByShard[shard] = append(result.AcceptedByShard[shard], reply.Accepted...)
			if len(reply.Rejected) == 0 {
				delete(failed, shard)
			} else {
				failed[shard] = reply.Rejected
			}
		}
	}
	for shard, pending := range failed {
		result.PendingByShard[shard] = pending
	}
	return result
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannel
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.jdk.CollectionConverters._

import metrics.v1.{MetricsWriterGrpc, WriteRequest}

object ShardFlush {
  val ShardWriters: Map[String, ManagedChannel] = Map.empty
  val MaxRetries: Int = 2

  // TODO: this draft retries every shard after any failure, sends windows without an id and reports
  // one success bit, so a retry re-sends accepted windows and a partial flush looks complete.
  def flushWindows(boundary: Long, windows: Map[String, Seq[String]]): Boolean = {
    var attempt = 0
    while (attempt <= MaxRetries) {
      var ok = false
      for (shard <- ShardWriters.keys) {
        try {
          val reply = MetricsWriterGrpc
            .newBlockingStub(ShardWriters(shard))
            .writeWindows(
              WriteRequest
                .newBuilder()
                .setShard(shard)
                .setBoundary(boundary)
                .addAllWindows(windows(shard).asJava)
                .build(),
            )
          if (reply.getAccepted) ok = true
        } catch {
          case _: io.grpc.StatusRuntimeException => ()
        }
      }
      if (ok) return true
      attempt += 1
    }
    false
  }

  val routes: Route = path("internal" / "flush") {
    post {
      complete(StatusCodes.Accepted)
    }
  }
}
`,
      solution: `import io.grpc.ManagedChannel
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import java.util.concurrent.TimeUnit

import scala.collection.mutable
import scala.jdk.CollectionConverters._

import metrics.v1.{MetricsWriterGrpc, WriteRequest}

final case class ShardReply(accepted: Seq[String], rejected: Seq[String])

/** acceptedByShard is what each shard took; pendingByShard is what the caller resumes with. */
final case class FlushResult(acceptedByShard: Map[String, Seq[String]], pendingByShard: Map[String, Seq[String]])

object ShardFlush {
  val FlushDeadlineMs: Long = 2000
  val MaxAttempts: Int = 3

  val ShardWriters: Map[String, ManagedChannel] = Map.empty

  def writeShard(shard: String, boundary: Long, windowIds: Seq[String]): ShardReply = {
    // One shard, one deadline, one dedupe key: a replayed window id is a no-op at the shard.
    val stub = MetricsWriterGrpc
      .newBlockingStub(ShardWriters(shard))
      .withDeadlineAfter(FlushDeadlineMs, TimeUnit.MILLISECONDS)
    val reply = stub.writeWindows(
      WriteRequest
        .newBuilder()
        .setShard(shard)
        .setBoundary(boundary)
        .addAllWindowIds(windowIds.asJava)
        .setDedupeByWindowId(true)
        .build(),
    )
    ShardReply(reply.getAcceptedWindowIdsList.asScala.toSeq, reply.getRejectedWindowIdsList.asScala.toSeq)
  }

  def flushWindows(boundary: Long, windows: Map[String, Seq[String]]): FlushResult = {
    val acceptedByShard = mutable.Map.empty[String, Seq[String]]
    var failed = windows
    var attempt = 0
    while (attempt < MaxAttempts && failed.nonEmpty) {
      for (shard <- failed.keys.toSeq.sorted) {
        try {
          val reply = writeShard(shard, boundary, failed(shard))
          acceptedByShard(shard) = acceptedByShard.getOrElse(shard, Seq.empty) ++ reply.accepted
          if (reply.rejected.isEmpty) failed -= shard else failed += (shard -> reply.rejected)
        } catch {
          case _: io.grpc.StatusRuntimeException => ()
        }
      }
      attempt += 1
    }
    FlushResult(acceptedByShard.toMap, failed)
  }

  val routes: Route = path("internal" / "flush") {
    post {
      complete(StatusCodes.Accepted)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "metrics.grpc.pb.h"

static const int kMaxRetries = 2;

static bool flush_windows(const std::map<std::string, std::shared_ptr<metrics::MetricsWriter::Stub>>& stubs,
                          long boundary, const std::map<std::string, std::vector<std::string>>& windows) {
  // TODO: this draft retries every shard after any failure, sends windows without an id and reports
  // one success bit, so a retry re-sends accepted windows and a partial flush looks complete.
  for (int attempt = 0; attempt <= kMaxRetries; ++attempt) {
    bool ok = false;
    for (const auto& [shard, stub] : stubs) {
      metrics::WriteRequest request;
      request.set_shard(shard);
      request.set_boundary(boundary);
      for (const auto& window : windows.at(shard)) request.add_windows(window);
      grpc::ClientContext ctx;
      metrics::WriteReply reply;
      if (stub->WriteWindows(&ctx, request, &reply).ok() && reply.accepted()) ok = true;
    }
    if (ok) return true;
  }
  return false;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "metrics.grpc.pb.h"

static const long kFlushDeadlineMs = 2000;
static const int kMaxAttempts = 3;

struct ShardReply {
  std::vector<std::string> accepted;
  std::vector<std::string> rejected;
};

struct FlushResult {
  std::map<std::string, std::vector<std::string>> accepted_by_shard;
  std::map<std::string, std::vector<std::string>> pending_by_shard;
};

static bool write_shard(const std::shared_ptr<metrics::MetricsWriter::Stub>& stub, const std::string& shard,
                        long boundary, const std::vector<std::string>& window_ids, ShardReply& out) {
  metrics::WriteRequest request;
  request.set_shard(shard);
  request.set_boundary(boundary);
  for (const auto& window_id : window_ids) request.add_window_ids(window_id);
  request.set_dedupe_by_window_id(true);

  // One shard, one deadline: a hung shard fails alone instead of holding the flush.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kFlushDeadlineMs));
  metrics::WriteReply reply;
  if (!stub->WriteWindows(&ctx, request, &reply).ok()) return false;
  out.accepted.assign(reply.accepted_window_ids().begin(), reply.accepted_window_ids().end());
  out.rejected.assign(reply.rejected_window_ids().begin(), reply.rejected_window_ids().end());
  return true;
}

static FlushResult flush_windows(const std::map<std::string, std::shared_ptr<metrics::MetricsWriter::Stub>>& stubs,
                                 long boundary, const std::map<std::string, std::vector<std::string>>& windows) {
  FlushResult result;
  auto failed = windows;
  for (int attempt = 0; attempt < kMaxAttempts && !failed.empty(); ++attempt) {
    for (auto it = failed.begin(); it != failed.end();) {
      ShardReply reply;
      if (!write_shard(stubs.at(it->first), it->first, boundary, it->second, reply)) {
        ++it;
        continue;
      }
      auto& accepted = result.accepted_by_shard[it->first];
      accepted.insert(accepted.end(), reply.accepted.begin(), reply.accepted.end());
      if (reply.rejected.empty()) {
        it = failed.erase(it);
      } else {
        it->second = reply.rejected;
        ++it;
      }
    }
  }
  result.pending_by_shard = failed;
  return result;
}
`,
    },
  },
  hints: [
    'A deadline belongs to a shard call, not to the flush. Pass `FLUSH_DEADLINE_MS` with every `WriteWindows` so one slow shard fails alone while the rest are still flushed this tick.',
    'The response is the retry plan. Keep the accepted window ids per shard, drop the shards that answered accepted out of the failed set, and loop over what is left — a loop over all shards re-sends windows that are already counted.',
    'Give every window an id and let the shard dedupe it. Then a partial flush is just data: return the pending windows per shard so the next tick resumes them, and treat the flush as complete only when every shard accepted everything it owns.',
  ],
  debrief: `The interviewer is testing whether you can review a fan-out client the way you would review a fan-out server call. The draft reads fine because the demo has healthy shards and one attempt always lands: it loops every shard on every retry, collapses the answers into one boolean, never sets a deadline, and sends windows as bare values. Five defects are checked here. A missing per-shard deadline lets one hung shard hold the flush past its budget; a single success bit makes a partial flush look complete, so nobody resumes it; a retry over all shards re-sends windows a shard already accepted and double-counts the minute; without a pending set the unaccepted windows are dropped rather than resumed; and without a window id the shard cannot tell a replay from a new window, which makes any retry unsafe. Real flush paths add jittered backoff with a per-shard attempt budget and a cap on how many windows fit in one call, an idempotency key carried by the window itself so the shard's write is a no-op on replay, and a reconciliation pass that compares each shard's accepted set against the window store before the boundary is closed.`,
};
