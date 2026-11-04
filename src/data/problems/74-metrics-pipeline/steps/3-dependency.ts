import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Shard-writer flushes: a deadline per shard, a result per window',
  concept: 'grpc',
  file: 'client',
  focus: ['redis', 'shards'],
  task: `## Task

**Starting point.** The starter is \`flush_windows(windows)\`, which the rollup tick calls with the
closed windows (\`{tenant, series, start, count, sum}\`): it groups them by \`shard_for(series)\`
(\`metrics.model\`), sends each shard \`MetricsWriter.WriteWindows\`, runs every shard again while any
call failed, at most \`FLUSH_ATTEMPTS\` (3) rounds, and returns \`True\` when a round had no failure.
With every shard healthy the demo flushes, and it hides 4 flaws.

\`\`\`proto
service MetricsWriter { rpc WriteWindows(WriteRequest) returns (WriteReply); }  // reply: accepted window ids
\`\`\`

**Failure mode the checks target.** A shard that hangs holds the whole flush; a shard that took some
windows and refused others reports success; a healthy shard is sent its windows again on every retry
round; and a shard has no way to recognise a window it already stored.

- Every call carries \`FLUSH_DEADLINE_S\` = **2 s**.
- Each \`Window\` carries \`window_id = window_id(w)\` (\`{tenant}/{series}@{start}\`).
- A round sends each shard only its windows still pending; a window leaves pending when its id is in
  the reply's \`accepted\`.
- The result is \`{"accepted": [ids], "pending": {shard target: [ids]}}\`, so the next tick resends
  exactly what is pending.`,
  sequence: {
    participants: ['Rollup tick', 'shard-0', 'shard-1', 'shard-2'],
    messages: [
      {from: 'Rollup tick', to: 'shard-0', label: 'WriteWindows · window ids · deadline 2 s', kind: 'sync'},
      {from: 'shard-0', to: 'Rollup tick', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Rollup tick', to: 'shard-1', label: 'WriteWindows', kind: 'sync'},
      {from: 'shard-1', to: 'Rollup tick', label: 'accepted [ids]', kind: 'reply'},
      {from: 'Rollup tick', to: 'shard-2', label: 'WriteWindows', kind: 'sync'},
      {from: 'shard-2', to: 'Rollup tick', label: 'accepted [some ids]', kind: 'reply'},
      {from: 'Rollup tick', to: 'shard-0', label: 'round 2: only what is still pending', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every shard call carries a 2-second deadline',
      detail:
        'Each `WriteWindows` call is made with `FLUSH_DEADLINE_S` (2 s), so a hung shard costs one deadline per round and its windows stay pending. The starter sets no deadline, so one stuck shard holds the flush for as long as it hangs.',
      match: {
        python: {all: [/FLUSH_DEADLINE_S\s*=\s*2\b/, /WriteWindows\([\s\S]{0,200}?timeout\s*=\s*FLUSH_DEADLINE_S/]},
        typescript: {
          all: [/FLUSH_DEADLINE_MS\s*=\s*2000\b/, /WriteWindows\([\s\S]{0,200}?deadline:[^\n]*FLUSH_DEADLINE_MS/],
        },
        go: {all: [/flushDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*flushDeadline\)/]},
        scala: {all: [/FlushDeadlineSeconds\s*=\s*2L?\b/, /withDeadlineAfter\(\s*FlushDeadlineSeconds/]},
        cpp: {all: [/kFlushDeadline\{2\}/, /set_deadline\([^\n]*kFlushDeadline\)/]},
      },
    },
    {
      id: 'per-shard-result',
      title: 'Reports accepted and pending windows',
      detail:
        "The result lists the accepted window ids and, per shard target, the ids still pending, built from each reply's `accepted`. The starter returns one boolean and ignores the reply, so a shard that refused half its windows counts as done.",
      match: {
        python: {all: [/["']pending["']/, /reply\.accepted/], none: [/return True\b/]},
        typescript: {all: [/pending/, /reply\.accepted/], none: [/Promise<boolean>/]},
        go: {all: [/model\.FlushResult\{/, /GetAccepted\(\)/], none: [/\)\s*bool\s*\{/]},
        scala: {all: [/FlushResult\(/, /reply\.accepted/], none: [/\):\s*Boolean\s*=/]},
        cpp: {all: [/metrics::FlushResult\s+flushWindows/, /reply\.accepted\(\)/], none: [/^bool flushWindows/m]},
      },
    },
    {
      id: 'retry-failed-only',
      title: 'Retries only the windows still pending',
      detail:
        'A retry round sends each shard only the windows it has not accepted; a shard that accepted everything is not called again. The starter loops over every shard on every round, so one failure resends every healthy shard its windows.',
      match: {
        python: {all: [/FLUSH_ATTEMPTS/, /pending/], none: [/in by_shard\.items\(\)/]},
        typescript: {all: [/FLUSH_ATTEMPTS/, /pending/], none: [/of byShard\)/]},
        go: {all: [/flushAttempts/, /pending/], none: [/range byShard\b/]},
        scala: {all: [/FlushAttempts/, /pending/], none: [/<- byShard\b|byShard\.foreach/]},
        cpp: {all: [/kFlushAttempts/, /pending/], none: [/:\s*byShard\)/]},
      },
    },
    {
      id: 'window-id',
      title: 'Sends every window with its window id',
      detail:
        'Each wire `Window` carries `window_id(w)` (`{tenant}/{series}@{start}`), which is what the shard deduplicates by: a window resent after a lost reply is stored once. The starter sends no id.',
      match: {
        python: {all: [/window_id\s*=/, /window_id\(w\)/]},
        typescript: {all: [/window_id:/, /windowId\(w\)/]},
        go: {all: [/WindowId:/, /model\.WindowID\(w\)/]},
        scala: {all: [/windowId\s*=/, /windowId\(w\)/]},
        cpp: {all: [/set_window_id\(/, /metrics::windowId\(w\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import metrics_pipeline_pb2 as pb
import metrics_pipeline_pb2_grpc as pb_grpc
from metrics.model import SHARDS, shard_for, window_id

FLUSH_ATTEMPTS = 3

stubs = {target: pb_grpc.MetricsWriterStub(grpc.insecure_channel(target)) for target in SHARDS}


def flush_windows(windows: list) -> bool:
    """Send every closed window to the shard writer its series lives on; True when the shards took them."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    by_shard = {}
    for w in windows:
        by_shard.setdefault(shard_for(w["series"]), []).append(w)
    for _ in range(FLUSH_ATTEMPTS):
        failed = False
        for target, batch in by_shard.items():
            request = pb.WriteRequest(
                shard=target,
                windows=[pb.Window(tenant=w["tenant"], series=w["series"], start=w["start"], count=w["count"], sum=w["sum"]) for w in batch],
            )
            try:
                stubs[target].WriteWindows(request)
            except grpc.RpcError:
                failed = True
        if not failed:
            return True
    return False
`,
      solution: `import grpc

import metrics_pipeline_pb2 as pb
import metrics_pipeline_pb2_grpc as pb_grpc
from metrics.model import SHARDS, shard_for, window_id

FLUSH_DEADLINE_S = 2
FLUSH_ATTEMPTS = 3

stubs = {target: pb_grpc.MetricsWriterStub(grpc.insecure_channel(target)) for target in SHARDS}


def flush_windows(windows: list) -> dict:
    """Send every closed window to its shard writer: {"accepted": [ids], "pending": {shard target: [ids]}}."""
    pending = {}
    for w in windows:
        pending.setdefault(shard_for(w["series"]), {})[window_id(w)] = w
    accepted = []
    for _ in range(FLUSH_ATTEMPTS):
        for target, batch in pending.items():
            if not batch:
                continue  # this shard took everything: it is not asked again
            request = pb.WriteRequest(
                shard=target,
                windows=[
                    pb.Window(window_id=wid, tenant=w["tenant"], series=w["series"], start=w["start"], count=w["count"], sum=w["sum"])
                    for wid, w in batch.items()
                ],
            )
            try:
                reply = stubs[target].WriteWindows(request, timeout=FLUSH_DEADLINE_S)
            except grpc.RpcError:
                continue  # the windows stay pending for the next round, or the next tick
            for wid in reply.accepted:
                if batch.pop(wid, None) is not None:
                    accepted.append(wid)
        if not any(pending.values()):
            break
    return {"accepted": accepted, "pending": {target: sorted(batch) for target, batch in pending.items() if batch}}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type FlushResult, SHARDS, type Window, shardFor, windowId} from 'metrics/model';

export const FLUSH_ATTEMPTS = 3;

interface WireWindow {
  window_id?: string;
  tenant: string;
  series: string;
  start: number;
  count: number;
  sum: number;
}

type Writer = grpc.Client & {
  WriteWindows(request: {shard: string; windows: WireWindow[]}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{accepted: string[]}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('metrics_pipeline.proto')) as unknown as {
  metricsd: {MetricsWriter: grpc.ServiceClientConstructor};
};
const writers: Record<string, Writer> = Object.fromEntries(
  SHARDS.map(target => [target, new pkg.metricsd.MetricsWriter(target, grpc.credentials.createInsecure()) as Writer]),
);

/** Send every closed window to the shard writer its series lives on; true when the shards took them. */
export async function flushWindows(windows: Window[]): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const byShard = new Map<string, Window[]>();
  for (const w of windows) byShard.set(shardFor(w.series), [...(byShard.get(shardFor(w.series)) ?? []), w]);
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
    let failed = false;
    for (const [target, batch] of byShard) {
      try {
        await writers[target].WriteWindows({shard: target, windows: batch}, new grpc.Metadata(), {});
      } catch {
        failed = true;
      }
    }
    if (!failed) return true;
  }
  return false;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type FlushResult, SHARDS, type Window, shardFor, windowId} from 'metrics/model';

export const FLUSH_DEADLINE_MS = 2000;
export const FLUSH_ATTEMPTS = 3;

interface WireWindow {
  window_id?: string;
  tenant: string;
  series: string;
  start: number;
  count: number;
  sum: number;
}

type Writer = grpc.Client & {
  WriteWindows(request: {shard: string; windows: WireWindow[]}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{accepted: string[]}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('metrics_pipeline.proto')) as unknown as {
  metricsd: {MetricsWriter: grpc.ServiceClientConstructor};
};
const writers: Record<string, Writer> = Object.fromEntries(
  SHARDS.map(target => [target, new pkg.metricsd.MetricsWriter(target, grpc.credentials.createInsecure()) as Writer]),
);

/** Send every closed window to its shard writer: the accepted ids, and per shard target the ids still pending. */
export async function flushWindows(windows: Window[]): Promise<FlushResult> {
  const pending = new Map<string, Map<string, Window>>();
  for (const w of windows) {
    const target = shardFor(w.series);
    pending.set(target, (pending.get(target) ?? new Map()).set(windowId(w), w));
  }
  const accepted: string[] = [];
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
    for (const [target, batch] of pending) {
      if (batch.size === 0) continue; // this shard took everything: it is not asked again
      const request = {shard: target, windows: [...batch].map(([id, w]) => ({window_id: id, ...w}))};
      let reply: {accepted: string[]};
      try {
        reply = await writers[target].WriteWindows(request, new grpc.Metadata(), {deadline: Date.now() + FLUSH_DEADLINE_MS});
      } catch {
        continue; // the windows stay pending for the next round, or the next tick
      }
      for (const id of reply.accepted ?? []) if (batch.delete(id)) accepted.push(id);
    }
    if ([...pending.values()].every(batch => batch.size === 0)) break;
  }
  const left: Record<string, string[]> = {};
  for (const [target, batch] of pending) if (batch.size > 0) left[target] = [...batch.keys()].sort();
  return {accepted, pending: left};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "metrics/gen/metrics_pipeline"
	"metrics/model" // model.Window, Shards, ShardFor, WindowID, FlushResult
)

const flushAttempts = 3

var writers = newWriters()

func newWriters() map[string]pb.MetricsWriterClient {
	out := map[string]pb.MetricsWriterClient{}
	for _, target := range model.Shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewMetricsWriterClient(conn)
	}
	return out
}

// flushWindows sends every closed window to the shard writer its series lives on; true when the shards took them.
func flushWindows(ctx context.Context, windows []model.Window) bool {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	byShard := map[string][]model.Window{}
	for _, w := range windows {
		byShard[model.ShardFor(w.Series)] = append(byShard[model.ShardFor(w.Series)], w)
	}
	for attempt := 0; attempt < flushAttempts; attempt++ {
		failed := false
		for target, batch := range byShard {
			request := &pb.WriteRequest{Shard: target}
			for _, w := range batch {
				request.Windows = append(request.Windows, &pb.Window{Tenant: w.Tenant, Series: w.Series, Start: w.Start, Count: w.Count, Sum: w.Sum})
			}
			if _, err := writers[target].WriteWindows(ctx, request); err != nil {
				failed = true
			}
		}
		if !failed {
			return true
		}
	}
	return false
}
`,
      solution: `package main

import (
	"context"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "metrics/gen/metrics_pipeline"
	"metrics/model" // model.Window, Shards, ShardFor, WindowID, FlushResult
)

const (
	flushDeadline = 2 * time.Second
	flushAttempts = 3
)

var writers = newWriters()

func newWriters() map[string]pb.MetricsWriterClient {
	out := map[string]pb.MetricsWriterClient{}
	for _, target := range model.Shards {
		conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[target] = pb.NewMetricsWriterClient(conn)
	}
	return out
}

// flushWindows sends every closed window to its shard writer: the accepted ids, and per shard target the ids still pending.
func flushWindows(ctx context.Context, windows []model.Window) model.FlushResult {
	pending := map[string]map[string]model.Window{}
	for _, w := range windows {
		target := model.ShardFor(w.Series)
		if pending[target] == nil {
			pending[target] = map[string]model.Window{}
		}
		pending[target][model.WindowID(w)] = w
	}
	accepted := []string{}
	for attempt := 0; attempt < flushAttempts; attempt++ {
		left := 0
		for _, target := range model.Shards {
			batch := pending[target]
			if len(batch) == 0 {
				continue // this shard took everything: it is not asked again
			}
			request := &pb.WriteRequest{Shard: target}
			for _, w := range batch {
				request.Windows = append(request.Windows, &pb.Window{WindowId: model.WindowID(w), Tenant: w.Tenant, Series: w.Series, Start: w.Start, Count: w.Count, Sum: w.Sum})
			}
			callCtx, cancel := context.WithTimeout(ctx, flushDeadline)
			reply, err := writers[target].WriteWindows(callCtx, request)
			cancel()
			if err == nil { // on an error the windows stay pending for the next round, or the next tick
				for _, id := range reply.GetAccepted() {
					if _, ok := batch[id]; ok {
						delete(batch, id)
						accepted = append(accepted, id)
					}
				}
			}
			left += len(batch)
		}
		if left == 0 {
			break
		}
	}
	result := model.FlushResult{Accepted: accepted, Pending: map[string][]string{}}
	for target, batch := range pending {
		if len(batch) == 0 {
			continue
		}
		ids := make([]string, 0, len(batch))
		for id := range batch {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		result.Pending[target] = ids
	}
	return result
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import metrics.Model.{FlushResult, Shards, Window, shardFor, windowId}
import metricsd.metrics_pipeline.{MetricsWriterGrpc, WriteRequest, Window => WireWindow}

object Client {
  val FlushAttempts = 3

  private val writers = Shards.map(target => target -> MetricsWriterGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build())).toMap

  /** Send every closed window to the shard writer its series lives on; true when the shards took them. */
  def flushWindows(windows: Seq[Window]): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val byShard = windows.groupBy(w => shardFor(w.series))
    (1 to FlushAttempts).exists { _ =>
      var failed = false
      for ((target, batch) <- byShard) {
        val request = WriteRequest(target, batch.map(w => WireWindow(tenant = w.tenant, series = w.series, start = w.start, count = w.count, sum = w.sum)))
        try writers(target).writeWindows(request)
        catch { case _: StatusRuntimeException => failed = true }
      }
      !failed
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import metrics.Model.{FlushResult, Shards, Window, shardFor, windowId}
import metricsd.metrics_pipeline.{MetricsWriterGrpc, WriteRequest, Window => WireWindow}

object Client {
  val FlushDeadlineSeconds = 2L
  val FlushAttempts = 3

  private val writers = Shards.map(target => target -> MetricsWriterGrpc.blockingStub(ManagedChannelBuilder.forTarget(target).usePlaintext().build())).toMap

  /** Send every closed window to its shard writer: the accepted ids, and per shard target the ids still pending. */
  def flushWindows(windows: Seq[Window]): FlushResult = {
    val pending = scala.collection.mutable.LinkedHashMap.empty[String, scala.collection.mutable.LinkedHashMap[String, Window]]
    windows.foreach(w => pending.getOrElseUpdate(shardFor(w.series), scala.collection.mutable.LinkedHashMap.empty)(windowId(w)) = w)
    val accepted = scala.collection.mutable.ArrayBuffer.empty[String]
    var attempt = 0
    while (attempt < FlushAttempts && pending.values.exists(_.nonEmpty)) {
      // A shard that took everything is not asked again.
      for ((target, batch) <- pending if batch.nonEmpty) {
        val request = WriteRequest(target, batch.values.toSeq.map(w =>
          WireWindow(windowId = windowId(w), tenant = w.tenant, series = w.series, start = w.start, count = w.count, sum = w.sum)))
        try {
          val reply = writers(target).withDeadlineAfter(FlushDeadlineSeconds, TimeUnit.SECONDS).writeWindows(request)
          reply.accepted.foreach(id => if (batch.remove(id).isDefined) accepted += id)
        } catch { case _: StatusRuntimeException => () } // the windows stay pending for the next round, or the next tick
      }
      attempt += 1
    }
    FlushResult(accepted.toSeq, pending.collect { case (target, batch) if batch.nonEmpty => target -> batch.keys.toSeq.sorted }.toMap)
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

#include "metrics/model.h"  // metrics::Window, kShards, shardFor, windowId, FlushResult
#include "metrics_pipeline.grpc.pb.h"

constexpr int kFlushAttempts = 3;

std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> makeWriters() {
  std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> out;
  for (const std::string& target : metrics::kShards) {
    out[target] = metricsd::MetricsWriter::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  }
  return out;
}

auto writers = makeWriters();

// Send every closed window to the shard writer its series lives on; true when the shards took them.
bool flushWindows(const std::vector<metrics::Window>& windows) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  std::map<std::string, std::vector<metrics::Window>> byShard;
  for (const metrics::Window& w : windows) byShard[metrics::shardFor(w.series)].push_back(w);
  for (int attempt = 0; attempt < kFlushAttempts; attempt++) {
    bool failed = false;
    for (const auto& [target, batch] : byShard) {
      metricsd::WriteRequest request;
      request.set_shard(target);
      for (const metrics::Window& w : batch) {
        metricsd::Window* out = request.add_windows();
        out->set_tenant(w.tenant);
        out->set_series(w.series);
        out->set_start(w.start);
        out->set_count(w.count);
        out->set_sum(w.sum);
      }
      grpc::ClientContext ctx;
      metricsd::WriteReply reply;
      if (!writers[target]->WriteWindows(&ctx, request, &reply).ok()) failed = true;
    }
    if (!failed) return true;
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

#include "metrics/model.h"  // metrics::Window, kShards, shardFor, windowId, FlushResult
#include "metrics_pipeline.grpc.pb.h"

constexpr std::chrono::seconds kFlushDeadline{2};
constexpr int kFlushAttempts = 3;

std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> makeWriters() {
  std::map<std::string, std::unique_ptr<metricsd::MetricsWriter::Stub>> out;
  for (const std::string& target : metrics::kShards) {
    out[target] = metricsd::MetricsWriter::NewStub(grpc::CreateChannel(target, grpc::InsecureChannelCredentials()));
  }
  return out;
}

auto writers = makeWriters();

// Send every closed window to its shard writer: the accepted ids, and per shard target the ids still pending.
metrics::FlushResult flushWindows(const std::vector<metrics::Window>& windows) {
  std::map<std::string, std::map<std::string, metrics::Window>> pending;
  for (const metrics::Window& w : windows) pending[metrics::shardFor(w.series)][metrics::windowId(w)] = w;
  metrics::FlushResult result;
  for (int attempt = 0; attempt < kFlushAttempts; attempt++) {
    size_t left = 0;
    for (auto& [target, batch] : pending) {
      if (batch.empty()) continue;  // this shard took everything: it is not asked again
      metricsd::WriteRequest request;
      request.set_shard(target);
      for (const auto& [id, w] : batch) {
        metricsd::Window* out = request.add_windows();
        out->set_window_id(metrics::windowId(w));
        out->set_tenant(w.tenant);
        out->set_series(w.series);
        out->set_start(w.start);
        out->set_count(w.count);
        out->set_sum(w.sum);
      }
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kFlushDeadline);
      metricsd::WriteReply reply;
      // On an error the windows stay pending for the next round, or the next tick.
      if (writers[target]->WriteWindows(&ctx, request, &reply).ok()) {
        for (const std::string& id : reply.accepted()) {
          if (batch.erase(id) > 0) result.accepted.push_back(id);
        }
      }
      left += batch.size();
    }
    if (left == 0) break;
  }
  for (const auto& [target, batch] : pending) {
    for (const auto& [id, w] : batch) result.pending[target].push_back(id);
  }
  return result;
}
`,
    },
  },
  harness: {
    python: `import grpc

import metrics_pipeline_pb2 as pb
import metrics_pipeline_pb2_grpc as pb_grpc
from metrics.model import SHARDS, shard_for, window_id

START = 1793747840


class Shard(pb_grpc.MetricsWriterServicer):
    """A shard writer: stores each window once per window id, refuses the ids in full."""

    def __init__(self):
        self.stored = {}
        self.received = []
        self.full = set()

    def WriteWindows(self, request, context):
        accepted = []
        for w in request.windows:
            self.received.append(w.window_id)
            if w.window_id in self.full:
                continue
            key = w.window_id or f"(no id) #{len(self.received)}"
            self.stored.setdefault(key, w.count)
            accepted.append(w.window_id)
        return pb.WriteReply(accepted=accepted)


def _setup(ctx, start=START):
    shards = {}
    for target in SHARDS:
        shards[target] = Shard()
        ctx.grpc.serve(pb_grpc.add_MetricsWriterServicer_to_server, shards[target], target)
    windows = [{"tenant": "acme", "series": f"cpu_seconds{{host=h{i}}}", "start": start, "count": i + 1, "sum": i * 1.5} for i in range(12)]
    by = {}
    for w in windows:
        by.setdefault(shard_for(w["series"]), []).append(window_id(w))
    assert set(by) == set(SHARDS), "harness setup: the windows must cover every shard"
    return ctx.load("client"), shards, windows, {target: sorted(ids) for target, ids in by.items()}


def _result(res, when):
    assert isinstance(res, dict) and "accepted" in res and "pending" in res, f"{when}, flush_windows returned {res!r}, expected {{'accepted': [ids], 'pending': {{shard: [ids]}}}}: one boolean cannot say which windows to resend"
    return res


def _pending(res):
    return {target: sorted(ids) for target, ids in res["pending"].items()}


def check_deadline(ctx):
    m, shards, windows, by = _setup(ctx)
    res = m.flush_windows(windows)
    calls = ctx.grpc.calls_to("WriteWindows")
    assert calls, "no WriteWindows call was made"
    for call in calls:
        assert call.timeout is not None, "a WriteWindows call carries no deadline: one hung shard holds the whole flush"
        assert 1.5 <= call.timeout <= 2.5, f"a WriteWindows call carries a {call.timeout} s deadline, expected FLUSH_DEADLINE_S = 2"
    _result(res, "with every shard healthy")
    slow = SHARDS[1]
    ctx.grpc.set_latency("WriteWindows", 30.0, slow)
    later = [{**w, "start": START + 10} for w in windows]
    before = ctx.clock.time()
    res = _result(m.flush_windows(later), f"with {slow} hanging")
    waited = ctx.clock.time() - before
    assert waited <= 7, f"the flush waited {waited:.0f} s on a hung shard: three rounds of a 2 s deadline is 6 s"
    want = sorted(window_id(w) for w in later if shard_for(w["series"]) == slow)
    assert _pending(res) == {slow: want}, f"with {slow} hanging the result's pending is {_pending(res)}, expected exactly its windows"


def check_per_shard_result(ctx):
    m, shards, windows, by = _setup(ctx)
    down, picky = SHARDS[2], SHARDS[0]
    ctx.grpc.stop(down)
    refused = by[picky][0]
    shards[picky].full.add(refused)
    res = _result(m.flush_windows(windows), f"with {down} down and {picky} refusing {refused}")
    assert _pending(res) == {picky: [refused], down: by[down]}, f"the result's pending is {_pending(res)}, expected {picky}: [{refused}] and every window of {down}"
    want = sorted(i for target, ids in by.items() if target != down for i in ids if i != refused)
    assert sorted(res["accepted"]) == want, f"the result accepted {sorted(res['accepted'])}, expected the {len(want)} windows the shards took"


def check_retry_failed_only(ctx):
    m, shards, windows, by = _setup(ctx)
    flaky = SHARDS[0]
    ctx.grpc.fail("WriteWindows", grpc.StatusCode.UNAVAILABLE, "shard restarting", 1, flaky)
    res = m.flush_windows(windows)
    calls = {target: len(ctx.grpc.calls_to("WriteWindows", target)) for target in SHARDS}
    want = {target: 2 if target == flaky else 1 for target in SHARDS}
    assert calls == want, f"one failure on {flaky} led to these calls per shard: {calls}, expected {want}: only the windows still pending are sent again"
    for target in SHARDS:
        assert len(shards[target].received) == len(by[target]), f"{target} received {len(shards[target].received)} windows for its {len(by[target])}: a healthy shard was sent its windows again"
    res = _result(res, f"after {flaky} recovered")
    assert res["pending"] == {} and len(res["accepted"]) == len(windows), f"after the retry every window is accepted, got {res}"


def check_window_id(ctx):
    m, shards, windows, by = _setup(ctx)
    m.flush_windows(windows)
    for target in SHARDS:
        got = sorted(shards[target].received)
        assert got == by[target], f"{target} received the window ids {got[:2]}…, expected {by[target][:2]}… (window_id(w) = tenant/series@start): without an id a shard cannot tell a resend from a new window"
    m.flush_windows(windows)  # the next tick resends: an earlier reply was lost
    stored = sum(len(s.stored) for s in shards.values())
    assert stored == len(windows), f"after a resend the shards store {stored} windows for {len(windows)}"
`,
    typescript: `const START = 1793747840;

interface Shard {
  stored: Map<string, number>;
  received: string[];
  full: Set<string>;
}

function setup(ctx, start = START) {
  const pkg = ctx.proto('metrics_pipeline.proto');
  const model = ctx.load('/support/metrics/model.ts');
  const shards: Record<string, Shard> = {};
  for (const target of model.SHARDS) {
    const shard: Shard = {stored: new Map(), received: [], full: new Set()};
    shards[target] = shard;
    ctx.grpc.serve(
      pkg.metricsd.MetricsWriter.service,
      {
        WriteWindows(call, callback) {
          const accepted: string[] = [];
          for (const w of call.request.windows) {
            shard.received.push(w.window_id);
            if (shard.full.has(w.window_id)) continue;
            const key = w.window_id || \`(no id) #\${shard.received.length}\`;
            if (!shard.stored.has(key)) shard.stored.set(key, Number(w.count));
            accepted.push(w.window_id);
          }
          callback(null, {accepted});
        },
      },
      target,
    );
  }
  const windows = Array.from({length: 12}, (_, i) => ({tenant: 'acme', series: \`cpu_seconds{host=h\${i}}\`, start, count: i + 1, sum: i * 1.5}));
  const by: Record<string, string[]> = {};
  for (const w of windows) (by[model.shardFor(w.series)] ??= []).push(model.windowId(w));
  for (const ids of Object.values(by)) ids.sort();
  assert.equal(Object.keys(by).length, 3, 'harness setup: the windows must cover every shard');
  return {m: ctx.load('client'), model, shards, windows, by};
}

function result(res, when: string) {
  assert(res !== null && typeof res === 'object' && 'accepted' in res && 'pending' in res, \`\${when}, flushWindows resolved \${JSON.stringify(res)}, expected {accepted: [ids], pending: {shard: [ids]}}: one boolean cannot say which windows to resend\`);
  return res;
}

const pendingOf = res => Object.fromEntries(Object.entries(res.pending).map(([t, ids]) => [t, [...(ids as string[])].sort()]));

export async function check_deadline(ctx) {
  const {m, model, windows} = setup(ctx);
  const res = await m.flushWindows(windows);
  const calls = ctx.grpc.callsTo('WriteWindows');
  assert(calls.length > 0, 'no WriteWindows call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'a WriteWindows call carries no deadline: one hung shard holds the whole flush');
    assert(call.timeout >= 1.5 && call.timeout <= 2.5, \`a WriteWindows call carries a \${call.timeout} s deadline, expected FLUSH_DEADLINE_MS = 2000\`);
  }
  result(res, 'with every shard healthy');
  const slow = model.SHARDS[1];
  ctx.grpc.setLatency('WriteWindows', 30, slow);
  const later = windows.map(w => ({...w, start: START + 10}));
  const before = ctx.clock.now();
  const res2 = result(await m.flushWindows(later), \`with \${slow} hanging\`);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 7, \`the flush waited \${waited.toFixed(0)} s on a hung shard: three rounds of a 2 s deadline is 6 s\`);
  const want = later.filter(w => model.shardFor(w.series) === slow).map(w => model.windowId(w)).sort();
  assert.deepStrictEqual(pendingOf(res2), {[slow]: want}, \`with \${slow} hanging the result's pending is \${JSON.stringify(pendingOf(res2))}, expected exactly its windows\`);
}

export async function check_per_shard_result(ctx) {
  const {m, model, shards, windows, by} = setup(ctx);
  const [picky, , down] = model.SHARDS;
  ctx.grpc.stop(down);
  const refused = by[picky][0];
  shards[picky].full.add(refused);
  const res = result(await m.flushWindows(windows), \`with \${down} down and \${picky} refusing \${refused}\`);
  assert.deepStrictEqual(pendingOf(res), {[picky]: [refused], [down]: by[down]}, \`the result's pending is \${JSON.stringify(pendingOf(res))}, expected \${picky}: [\${refused}] and every window of \${down}\`);
  const want = Object.entries(by).filter(([t]) => t !== down).flatMap(([, ids]) => ids).filter(id => id !== refused).sort();
  assert.deepStrictEqual([...res.accepted].sort(), want, \`the result accepted \${JSON.stringify(res.accepted)}, expected the \${want.length} windows the shards took\`);
}

export async function check_retry_failed_only(ctx) {
  const {m, model, shards, windows, by} = setup(ctx);
  const flaky = model.SHARDS[0];
  ctx.grpc.fail('WriteWindows', ctx.grpc.status.UNAVAILABLE, 'shard restarting', 1, flaky);
  const res = await m.flushWindows(windows);
  const calls = Object.fromEntries(model.SHARDS.map(t => [t, ctx.grpc.callsTo('WriteWindows', t).length]));
  const want = Object.fromEntries(model.SHARDS.map(t => [t, t === flaky ? 2 : 1]));
  assert.deepStrictEqual(calls, want, \`one failure on \${flaky} led to these calls per shard: \${JSON.stringify(calls)}: only the windows still pending are sent again\`);
  for (const t of model.SHARDS) {
    assert.equal(shards[t].received.length, by[t].length, \`\${t} received \${shards[t].received.length} windows for its \${by[t].length}: a healthy shard was sent its windows again\`);
  }
  result(res, \`after \${flaky} recovered\`);
  assert(Object.keys(res.pending).length === 0 && res.accepted.length === windows.length, \`after the retry every window is accepted, got \${JSON.stringify(res)}\`);
}

export async function check_window_id(ctx) {
  const {m, model, shards, windows, by} = setup(ctx);
  await m.flushWindows(windows);
  for (const t of model.SHARDS) {
    const got = [...shards[t].received].sort();
    assert.deepStrictEqual(got, by[t], \`\${t} received the window ids \${JSON.stringify(got.slice(0, 2))}…, expected \${JSON.stringify(by[t].slice(0, 2))}… (windowId(w) = tenant/series@start): without an id a shard cannot tell a resend from a new window\`);
  }
  await m.flushWindows(windows); // the next tick resends: an earlier reply was lost
  const stored = Object.values(shards).reduce((n, s) => n + s.stored.size, 0);
  assert.equal(stored, windows.length, \`after a resend the shards store \${stored} windows for \${windows.length}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"

	"google.golang.org/grpc/codes"

	pb "metrics/gen/metrics_pipeline"
	"metrics/model"

	"leetbuild/harness"
)

const clientStart = 1793747840

var clientBg = context.Background()

// shardPeer is a shard writer: it stores each window once per window id and refuses the ids in full.
type shardPeer struct {
	pb.UnimplementedMetricsWriterServer
	stored   map[string]int64
	received []string
	full     map[string]bool
}

func (s *shardPeer) WriteWindows(_ context.Context, req *pb.WriteRequest) (*pb.WriteReply, error) {
	accepted := []string{}
	for _, w := range req.GetWindows() {
		s.received = append(s.received, w.GetWindowId())
		if s.full[w.GetWindowId()] {
			continue
		}
		key := w.GetWindowId()
		if key == "" {
			key = fmt.Sprintf("(no id) #%d", len(s.received))
		}
		if _, ok := s.stored[key]; !ok {
			s.stored[key] = w.GetCount()
		}
		accepted = append(accepted, w.GetWindowId())
	}
	return &pb.WriteReply{Accepted: accepted}, nil
}

func clientSetup(ctx *harness.Ctx, start int64) (map[string]*shardPeer, []model.Window, map[string][]string) {
	shards := map[string]*shardPeer{}
	for _, target := range model.Shards {
		peer := &shardPeer{stored: map[string]int64{}, full: map[string]bool{}}
		shards[target] = peer
		pb.RegisterMetricsWriterServer(ctx.GRPC.Server(target), peer)
	}
	windows := []model.Window{}
	by := map[string][]string{}
	for i := 0; i < 12; i++ {
		w := model.Window{Tenant: "acme", Series: fmt.Sprintf("cpu_seconds{host=h%d}", i), Start: start, Count: int64(i + 1), Sum: float64(i) * 1.5}
		windows = append(windows, w)
		by[model.ShardFor(w.Series)] = append(by[model.ShardFor(w.Series)], model.WindowID(w))
	}
	for _, ids := range by {
		sort.Strings(ids)
	}
	ctx.Equal(len(by), 3, "harness setup: the windows must cover every shard")
	return shards, windows, by
}

func clientResult(ctx *harness.Ctx, res any, when string) model.FlushResult {
	result, ok := res.(model.FlushResult)
	ctx.Assert(ok, "%s, flushWindows returned %v, expected a model.FlushResult with Accepted and Pending: one boolean cannot say which windows to resend", when, res)
	return result
}

func sortedIDs(ids []string) []string {
	out := append([]string{}, ids...)
	sort.Strings(out)
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	_, windows, _ := clientSetup(ctx, clientStart)
	res := any(flushWindows(clientBg, windows))
	calls := ctx.GRPC.CallsTo("WriteWindows", "")
	ctx.Assert(len(calls) > 0, "no WriteWindows call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a WriteWindows call carries no deadline: one hung shard holds the whole flush")
		ctx.Assert(call.Timeout.Seconds() >= 1.5 && call.Timeout.Seconds() <= 2.5, "a WriteWindows call carries a %v deadline, expected flushDeadline = 2 s", call.Timeout)
	}
	clientResult(ctx, res, "with every shard healthy")
	slow := model.Shards[1]
	ctx.GRPC.SetLatency("WriteWindows", 30, slow)
	later := []model.Window{}
	want := []string{}
	for _, w := range windows {
		w.Start = clientStart + 10
		later = append(later, w)
		if model.ShardFor(w.Series) == slow {
			want = append(want, model.WindowID(w))
		}
	}
	before := ctx.Clock.Now()
	result := clientResult(ctx, any(flushWindows(clientBg, later)), "with "+slow+" hanging")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 7, "the flush waited %.0f s on a hung shard: three rounds of a 2 s deadline is 6 s", waited)
	ctx.Equal(len(result.Pending), 1, "with %s hanging only its windows are pending; the shards with pending windows (%v)", slow, result.Pending)
	ctx.Equal(sortedIDs(result.Pending[slow]), sortedIDs(want), "with %s hanging, its pending windows", slow)
}

func CheckPerShardResult(ctx *harness.Ctx) {
	shards, windows, by := clientSetup(ctx, clientStart)
	down, picky := model.Shards[2], model.Shards[0]
	ctx.GRPC.Stop(down)
	refused := by[picky][0]
	shards[picky].full[refused] = true
	result := clientResult(ctx, any(flushWindows(clientBg, windows)), fmt.Sprintf("with %s down and %s refusing %s", down, picky, refused))
	ctx.Equal(len(result.Pending), 2, "the shards with pending windows (%v), expected %s and %s", result.Pending, picky, down)
	ctx.Equal(sortedIDs(result.Pending[picky]), []string{refused}, "%s refused one window; its pending ids", picky)
	ctx.Equal(sortedIDs(result.Pending[down]), by[down], "%s is down; its pending ids", down)
	want := []string{}
	for target, ids := range by {
		for _, id := range ids {
			if target != down && id != refused {
				want = append(want, id)
			}
		}
	}
	ctx.Equal(sortedIDs(result.Accepted), sortedIDs(want), "the accepted ids (the windows the shards took)")
}

func CheckRetryFailedOnly(ctx *harness.Ctx) {
	shards, windows, by := clientSetup(ctx, clientStart)
	flaky := model.Shards[0]
	ctx.GRPC.Fail("WriteWindows", codes.Unavailable, "shard restarting", 1, flaky)
	res := any(flushWindows(clientBg, windows))
	for _, target := range model.Shards {
		want := 1
		if target == flaky {
			want = 2
		}
		ctx.Equal(len(ctx.GRPC.CallsTo("WriteWindows", target)), want, "one failure on %s: only the windows still pending are sent again; the calls to %s", flaky, target)
		ctx.Equal(len(shards[target].received), len(by[target]), "%s must receive each of its windows once (a healthy shard sent its windows again); the windows it received", target)
	}
	result := clientResult(ctx, res, "after "+flaky+" recovered")
	ctx.Assert(len(result.Pending) == 0 && len(result.Accepted) == len(windows), "after the retry every window is accepted, got %+v", result)
}

func CheckWindowId(ctx *harness.Ctx) {
	shards, windows, by := clientSetup(ctx, clientStart)
	flushWindows(clientBg, windows)
	for _, target := range model.Shards {
		ctx.Equal(sortedIDs(shards[target].received), by[target], "%s must receive each window with window_id = model.WindowID(w) (tenant/series@start): without an id a shard cannot tell a resend from a new window; the ids", target)
	}
	flushWindows(clientBg, windows) // the next tick resends: an earlier reply was lost
	stored := 0
	for _, s := range shards {
		stored += len(s.stored)
	}
	ctx.Equal(stored, len(windows), "after a resend, the windows the shards store")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <array>
#include <map>
#include <set>
#include <string>
#include <type_traits>
#include <vector>

namespace {

constexpr long long kStart = 1793747840;

// A shard writer: stores each window once per window id, refuses the ids in full.
class ShardPeer final : public metricsd::MetricsWriter::Service {
 public:
  std::map<std::string, long long> stored;
  std::vector<std::string> received;
  std::set<std::string> full;
  grpc::Status WriteWindows(grpc::ServerContext*, const metricsd::WriteRequest* req, metricsd::WriteReply* out) override {
    for (const auto& w : req->windows()) {
      received.push_back(w.window_id());
      if (full.count(w.window_id())) continue;
      const std::string key = w.window_id().empty() ? "(no id) #" + std::to_string(received.size()) : w.window_id();
      stored.emplace(key, w.count());
      out->add_accepted(w.window_id());
    }
    return grpc::Status::OK;
  }
};

struct Setup {
  std::map<std::string, ShardPeer*> shards;
  std::vector<metrics::Window> windows;
  std::map<std::string, std::vector<std::string>> by;
};

Setup clientSetup(harness::Ctx& ctx, long long start = kStart) {
  static std::array<ShardPeer, 3>* peers = nullptr;
  delete peers;
  peers = new std::array<ShardPeer, 3>;
  Setup s;
  for (size_t i = 0; i < metrics::kShards.size(); i++) {
    s.shards[metrics::kShards[i]] = &(*peers)[i];
    ctx.GRPC.Server(metrics::kShards[i])->RegisterService(&(*peers)[i]);
  }
  for (int i = 0; i < 12; i++) {
    const metrics::Window w{"acme", "cpu_seconds{host=h" + std::to_string(i) + "}", start, i + 1, i * 1.5};
    s.windows.push_back(w);
    s.by[metrics::shardFor(w.series)].push_back(metrics::windowId(w));
  }
  for (auto& [target, ids] : s.by) std::sort(ids.begin(), ids.end());
  ctx.Equal(s.by.size(), 3, "harness setup: the windows must cover every shard");
  return s;
}

template <class R>
metrics::FlushResult clientResult(harness::Ctx& ctx, const R& res, const std::string& when) {
  if constexpr (std::is_same_v<R, metrics::FlushResult>) {
    return res;
  } else {
    ctx.Fatalf("%s, flushWindows returned %v, expected a metrics::FlushResult with accepted and pending: one boolean cannot say which windows to resend", when, res);
    return {};
  }
}

std::vector<std::string> sortedIds(std::vector<std::string> ids) {
  std::sort(ids.begin(), ids.end());
  return ids;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  auto s = clientSetup(ctx);
  const auto res = flushWindows(s.windows);
  const auto calls = ctx.GRPC.CallsTo("WriteWindows");
  ctx.Assert(!calls.empty(), "no WriteWindows call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a WriteWindows call carries no deadline: one hung shard holds the whole flush");
    ctx.Assert(call.TimeoutSeconds() >= 1.5 && call.TimeoutSeconds() <= 2.5, "a WriteWindows call carries a %v s deadline, expected kFlushDeadline = 2 s", call.TimeoutSeconds());
  }
  clientResult(ctx, res, "with every shard healthy");
  const std::string slow = metrics::kShards[1];
  ctx.GRPC.SetLatency("WriteWindows", 30, slow);
  std::vector<metrics::Window> later;
  std::vector<std::string> want;
  for (metrics::Window w : s.windows) {
    w.start = kStart + 10;
    later.push_back(w);
    if (metrics::shardFor(w.series) == slow) want.push_back(metrics::windowId(w));
  }
  const int64_t before = ctx.Clock.Now();
  const auto result = clientResult(ctx, flushWindows(later), "with " + slow + " hanging");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 7, "the flush waited %.0f s on a hung shard: three rounds of a 2 s deadline is 6 s", waited);
  ctx.Equal(result.pending.size(), 1, "with %s hanging only its windows are pending; the shards with pending windows", slow);
  ctx.Equal(sortedIds(result.pending.count(slow) ? result.pending.at(slow) : std::vector<std::string>{}), sortedIds(want), "with %s hanging, its pending windows", slow);
}

void CheckPerShardResult(harness::Ctx& ctx) {
  auto s = clientSetup(ctx);
  const std::string down = metrics::kShards[2], picky = metrics::kShards[0];
  ctx.GRPC.Stop(down);
  const std::string refused = s.by[picky][0];
  s.shards[picky]->full.insert(refused);
  const auto result = clientResult(ctx, flushWindows(s.windows), "with " + down + " down and " + picky + " refusing " + refused);
  ctx.Equal(result.pending.size(), 2, "the shards with pending windows, expected %s and %s", picky, down);
  ctx.Equal(result.pending.count(picky) ? sortedIds(result.pending.at(picky)) : std::vector<std::string>{}, std::vector<std::string>{refused}, "%s refused one window; its pending ids", picky);
  ctx.Equal(result.pending.count(down) ? sortedIds(result.pending.at(down)) : std::vector<std::string>{}, s.by[down], "%s is down; its pending ids", down);
  std::vector<std::string> want;
  for (const auto& [target, ids] : s.by) {
    for (const auto& id : ids) {
      if (target != down && id != refused) want.push_back(id);
    }
  }
  ctx.Equal(sortedIds(result.accepted), sortedIds(want), "the accepted ids (the windows the shards took)");
}

void CheckRetryFailedOnly(harness::Ctx& ctx) {
  auto s = clientSetup(ctx);
  const std::string flaky = metrics::kShards[0];
  ctx.GRPC.Fail("WriteWindows", grpc::StatusCode::UNAVAILABLE, "shard restarting", 1, flaky);
  const auto res = flushWindows(s.windows);
  for (const auto& target : metrics::kShards) {
    ctx.Equal(ctx.GRPC.CallsTo("WriteWindows", target).size(), target == flaky ? 2 : 1, "one failure on %s: only the windows still pending are sent again; the calls to %s", flaky, target);
    ctx.Equal(s.shards[target]->received.size(), s.by[target].size(), "%s must receive each of its windows once (a healthy shard sent its windows again); the windows it received", target);
  }
  const auto result = clientResult(ctx, res, "after " + flaky + " recovered");
  ctx.Assert(result.pending.empty() && result.accepted.size() == s.windows.size(), "after the retry every window is accepted, got %d accepted and %d shards pending", result.accepted.size(), result.pending.size());
}

void CheckWindowId(harness::Ctx& ctx) {
  auto s = clientSetup(ctx);
  flushWindows(s.windows);
  for (const auto& target : metrics::kShards) {
    ctx.Equal(sortedIds(s.shards[target]->received), s.by[target], "%s must receive each window with window_id = metrics::windowId(w) (tenant/series@start): without an id a shard cannot tell a resend from a new window; the ids", target);
  }
  flushWindows(s.windows);  // the next tick resends: an earlier reply was lost
  size_t stored = 0;
  for (const auto& [target, peer] : s.shards) stored += peer->stored.size();
  ctx.Equal(stored, s.windows.size(), "after a resend, the windows the shards store");
}
`,
  },
  hints: [
    'Hang one shard and the flush hangs with it; refuse one window on another shard and the flush still reports success, while a shard that answered on the first round is asked again on the next.',
    "The loop's unit is the shard, not the window: every round walks every shard, a failure anywhere marks the whole round failed, and the reply's `accepted` list is never read. No call has a deadline, no window has an id.",
    'Keep `pending[target][window_id(w)] = w`. Each round, send each shard its pending windows with `window_id` and `timeout=FLUSH_DEADLINE_S`; remove the reply\'s `accepted` ids; skip empty shards. Return `{"accepted": ids, "pending": {target: sorted ids}}`.',
  ],
  debrief: `The window, not the shard and not the flush, is the unit of progress, so the state the loop carries is a set of pending window ids per shard, and the result reports that set. The deadline bounds what one bad shard can cost; the window id is what lets a resend after a lost reply be a no-op at the shard; skipping shards with nothing pending is what keeps a retry from rewriting windows a healthy shard already holds. Production flushers add jittered backoff between rounds, cap how many windows one request carries, and persist the pending set so a restart of the rollup worker resumes rather than recomputes.`,
};
