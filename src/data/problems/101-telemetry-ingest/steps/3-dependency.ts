import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Time-series writes that retry only what failed',
  concept: 'grpc',
  file: 'client',
  focus: ['ingest', 'tsdb'],
  task: `## Task

**Starting point.** The starter implements \`write_batch(batch_id, sub_batches)\`, which stores one WAL
batch in the time-series store: in a \`while True\` loop it sends every sub-batch in a \`WriteRequest\`
to \`TimeSeries.Write\` with no deadline and no batch id, sleeps a second after an RPC error, and
returns \`{"complete": True, …}\` as soon as a reply accepted any sub-batch. With a healthy store the
demo stores every point. It hides five flaws.

**Failure mode the checks target.** A stalled store pins the writer; a store that is down turns it
into a retry loop with no end; sub-batches the store already took are sent again, which doubles the
fleet's totals; the store has no batch id to dedupe on; and a batch is reported complete while one of
its sub-batches is missing.

- Each attempt carries a **4-second deadline** (\`DEADLINE_S\`); at most \`MAX_ATTEMPTS = 3\` attempts.
- The reply names the \`accepted\` and \`failed\` sub-batch ids. Keep the sub-batches still \`pending\`
  and send only those on the next attempt.
- Every attempt carries the caller's \`batch_id\`.
- Return \`{"complete", "accepted", "failed"}\`: complete only when nothing is pending, and \`failed\`
  lists the ids that are.`,
  sequence: {
    participants: ['Telemetry Ingest', 'Time-series store'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'Time-series store',
        label: 'Write · batch_id b-1 · s1 s2 s3 · deadline 4 s',
        kind: 'sync',
      },
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'accepted [s1, s2] · failed [s3]', kind: 'reply'},
      {from: 'Telemetry Ingest', to: 'Time-series store', label: 'Write · batch_id b-1 · s3 only', kind: 'sync'},
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'accepted [s3]', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'complete: nothing pending · or give up after 3 attempts',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 4-second deadline',
      detail:
        'Each `Write` is sent with a deadline of 4 seconds, so a stalled store costs at most three deadlines. The starter sets none and waits for as long as the store does.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*4/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*4000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*4\s*\*\s*time\.Second/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineSeconds\s*=\s*4/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadline\{4\}/, /set_deadline\(/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'Gives up after three attempts',
      detail:
        'With the store down, `write_batch` makes exactly `MAX_ATTEMPTS = 3` calls and reports the batch incomplete. The starter loops until the store answers, so an outage turns every writer into a retry loop.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /range\(MAX_ATTEMPTS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/], none: [/\bfor\s*\{/]},
        scala: {all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /attempt\s*<\s*kMaxAttempts/], none: [/for\s*\(\s*;\s*;\s*\)/]},
      },
    },
    {
      id: 'failed-only',
      title: 'Retries only the sub-batches still pending',
      detail:
        'After a reply that accepted s1 and s2 and failed s3, the next requests carry s3 alone and the store holds each sub-batch once. The starter builds every request from the whole batch, so an accepted sub-batch is stored again.',
      match: {
        python: {all: [/sub_batches\s*=\s*pending/]},
        typescript: {all: [/sub_batches:\s*pending/]},
        go: {all: [/SubBatches:\s*pending/]},
        scala: {all: [/subBatches\s*=\s*pending/]},
        cpp: {all: [/:\s*pending\)\s*\*request\.add_sub_batches\(\)/]},
      },
    },
    {
      id: 'batch-id',
      title: 'Every attempt carries the caller’s batch id',
      detail:
        'Each `WriteRequest` carries the `batch_id` the caller passed, the key the store deduplicates on. The starter sends an empty one.',
      match: {
        python: {all: [/batch_id\s*=\s*batch_id/]},
        typescript: {all: [/batch_id:\s*batchId/]},
        go: {all: [/BatchId:\s*batchID/]},
        scala: {all: [/batchId\s*=\s*batchId/]},
        cpp: {all: [/set_batch_id\(\s*batch_id\s*\)/]},
      },
    },
    {
      id: 'done-all',
      title: 'Complete only when every sub-batch is stored',
      detail:
        'A sub-batch that fails on every attempt leaves the batch incomplete, with that id in `failed` and the others in `accepted`. The starter answers complete as soon as one sub-batch was accepted.',
      match: {
        python: {
          all: [/not\s+pending|len\(pending\)\s*==\s*0/],
          none: [/len\(reply\.accepted\)\s*>\s*0/, /["']complete["']\s*:\s*True/],
        },
        typescript: {
          all: [/pending\.length\s*===\s*0/],
          none: [/reply\.accepted\.length\s*>\s*0/, /complete:\s*true/],
        },
        go: {all: [/len\(pending\)\s*==\s*0/], none: [/len\(reply\.GetAccepted\(\)\)\s*>\s*0/, /Complete:\s*true/]},
        scala: {all: [/pending\.isEmpty/], none: [/accepted\.nonEmpty/, /complete\s*=\s*true/]},
        cpp: {all: [/pending\.empty\(\)/], none: [/accepted_size\(\)\s*>\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc

store = telemetry_ingest_pb2_grpc.TimeSeriesStub(grpc.insecure_channel("tsdb:9000"))


def write_batch(batch_id: str, sub_batches: list) -> dict:
    """Store every sub-batch (telemetry_ingest_pb2.SubBatch) of one WAL batch; ids in {"complete", "accepted", "failed"}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        try:
            reply = store.Write(telemetry_ingest_pb2.WriteRequest(sub_batches=sub_batches))
        except grpc.RpcError:
            time.sleep(1.0)  # the store is busy: try again
            continue
        if len(reply.accepted) > 0:
            return {"complete": True, "accepted": list(reply.accepted), "failed": list(reply.failed)}
`,
      solution: `import grpc

import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc

DEADLINE_S = 4.0
MAX_ATTEMPTS = 3

store = telemetry_ingest_pb2_grpc.TimeSeriesStub(grpc.insecure_channel("tsdb:9000"))


def write_batch(batch_id: str, sub_batches: list) -> dict:
    """Store every sub-batch (telemetry_ingest_pb2.SubBatch) of one WAL batch; ids in {"complete", "accepted", "failed"}."""
    pending = list(sub_batches)
    accepted: list[str] = []
    for _ in range(MAX_ATTEMPTS):
        try:
            # The batch id is the store's dedupe key: every attempt carries the same one.
            reply = store.Write(telemetry_ingest_pb2.WriteRequest(batch_id=batch_id, sub_batches=pending), timeout=DEADLINE_S)
        except grpc.RpcError:
            continue  # nothing was acknowledged: the same sub-batches go again
        accepted.extend(reply.accepted)
        stored = set(reply.accepted)
        # Only what the store did not take goes again: an accepted sub-batch is never re-sent.
        pending = [sub for sub in pending if sub.id not in stored]
        if not pending:
            break
    return {"complete": not pending, "accepted": accepted, "failed": [sub.id for sub in pending]}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export interface Point {
  metric: string;
  value: number;
  ts: number;
}

export interface SubBatch {
  id: string;
  device_id: string;
  points: Point[];
}

export interface WriteResult {
  complete: boolean;
  accepted: string[];
  failed: string[];
}

interface WriteRequest {
  batch_id?: string;
  sub_batches: SubBatch[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('telemetry_ingest.proto')) as unknown as {
  tsdb: {TimeSeries: grpc.ServiceClientConstructor};
};
const store = new pkg.tsdb.TimeSeries('tsdb:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{accepted: string[]; failed: string[]}>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Store every sub-batch of one WAL batch; ids in {complete, accepted, failed}. */
export async function writeBatch(batchId: string, subBatches: SubBatch[]): Promise<WriteResult> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (;;) {
    let reply: {accepted: string[]; failed: string[]};
    try {
      reply = await store.Write({sub_batches: subBatches}, new grpc.Metadata(), {});
    } catch {
      await sleep(1000); // the store is busy: try again
      continue;
    }
    if (reply.accepted.length > 0) return {complete: true, accepted: reply.accepted, failed: reply.failed};
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEADLINE_MS = 4000;
export const MAX_ATTEMPTS = 3;

export interface Point {
  metric: string;
  value: number;
  ts: number;
}

export interface SubBatch {
  id: string;
  device_id: string;
  points: Point[];
}

export interface WriteResult {
  complete: boolean;
  accepted: string[];
  failed: string[];
}

interface WriteRequest {
  batch_id?: string;
  sub_batches: SubBatch[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('telemetry_ingest.proto')) as unknown as {
  tsdb: {TimeSeries: grpc.ServiceClientConstructor};
};
const store = new pkg.tsdb.TimeSeries('tsdb:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{accepted: string[]; failed: string[]}>;
};

/** Store every sub-batch of one WAL batch; ids in {complete, accepted, failed}. */
export async function writeBatch(batchId: string, subBatches: SubBatch[]): Promise<WriteResult> {
  let pending = [...subBatches];
  const accepted: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
    let reply: {accepted: string[]; failed: string[]};
    try {
      // The batch id is the store's dedupe key: every attempt carries the same one.
      reply = await store.Write({batch_id: batchId, sub_batches: pending}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch {
      continue; // nothing was acknowledged: the same sub-batches go again
    }
    accepted.push(...reply.accepted);
    const stored = new Set(reply.accepted);
    // Only what the store did not take goes again: an accepted sub-batch is never re-sent.
    pending = pending.filter(sub => !stored.has(sub.id));
  }
  return {complete: pending.length === 0, accepted, failed: pending.map(sub => sub.id)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "tsdb/gen/telemetry_ingest"
)

var (
	storeConn, _ = grpc.NewClient("tsdb:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	store        = pb.NewTimeSeriesClient(storeConn)
)

// WriteResult reports a batch by sub-batch id.
type WriteResult struct {
	Complete bool
	Accepted []string
	Failed   []string
}

// writeBatch stores every sub-batch of one WAL batch.
func writeBatch(ctx context.Context, batchID string, subBatches []*pb.SubBatch) WriteResult {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		reply, err := store.Write(ctx, &pb.WriteRequest{SubBatches: subBatches})
		if err != nil {
			time.Sleep(time.Second) // the store is busy: try again
			continue
		}
		if len(reply.GetAccepted()) > 0 {
			return WriteResult{Complete: true, Accepted: reply.GetAccepted(), Failed: reply.GetFailed()}
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "tsdb/gen/telemetry_ingest"
)

const (
	deadline    = 4 * time.Second
	maxAttempts = 3
)

var (
	storeConn, _ = grpc.NewClient("tsdb:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	store        = pb.NewTimeSeriesClient(storeConn)
)

// WriteResult reports a batch by sub-batch id.
type WriteResult struct {
	Complete bool
	Accepted []string
	Failed   []string
}

// writeBatch stores every sub-batch of one WAL batch.
func writeBatch(ctx context.Context, batchID string, subBatches []*pb.SubBatch) WriteResult {
	pending := subBatches
	accepted := []string{}
	for attempt := 0; attempt < maxAttempts && len(pending) > 0; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		// The batch id is the store's dedupe key: every attempt carries the same one.
		reply, err := store.Write(callCtx, &pb.WriteRequest{BatchId: batchID, SubBatches: pending})
		cancel()
		if err != nil {
			continue // nothing was acknowledged: the same sub-batches go again
		}
		accepted = append(accepted, reply.GetAccepted()...)
		stored := map[string]bool{}
		for _, id := range reply.GetAccepted() {
			stored[id] = true
		}
		// Only what the store did not take goes again: an accepted sub-batch is never re-sent.
		var next []*pb.SubBatch
		for _, sub := range pending {
			if !stored[sub.GetId()] {
				next = append(next, sub)
			}
		}
		pending = next
	}
	failed := []string{}
	for _, sub := range pending {
		failed = append(failed, sub.GetId())
	}
	return WriteResult{Complete: len(pending) == 0, Accepted: accepted, Failed: failed}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import tsdb.telemetry_ingest.{SubBatch, TimeSeriesGrpc, WriteRequest}

/** A batch reported by sub-batch id. */
final case class WriteResult(complete: Boolean, accepted: Seq[String], failed: Seq[String])

object TsdbClient {
  private val store = TimeSeriesGrpc.blockingStub(ManagedChannelBuilder.forAddress("tsdb", 9000).usePlaintext().build())

  /** Store every sub-batch of one WAL batch. */
  def writeBatch(batchId: String, subBatches: Seq[SubBatch]): WriteResult = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    var result: Option[WriteResult] = None
    while (result.isEmpty) {
      try {
        val reply = store.write(WriteRequest(subBatches = subBatches))
        if (reply.accepted.nonEmpty) result = Some(WriteResult(complete = true, reply.accepted, reply.failed))
      } catch {
        case _: StatusRuntimeException => Thread.sleep(1000) // the store is busy: try again
      }
    }
    result.get
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import tsdb.telemetry_ingest.{SubBatch, TimeSeriesGrpc, WriteRequest}

/** A batch reported by sub-batch id. */
final case class WriteResult(complete: Boolean, accepted: Seq[String], failed: Seq[String])

object TsdbClient {
  val DeadlineSeconds = 4L
  val MaxAttempts = 3

  private val store = TimeSeriesGrpc.blockingStub(ManagedChannelBuilder.forAddress("tsdb", 9000).usePlaintext().build())

  /** Store every sub-batch of one WAL batch. */
  def writeBatch(batchId: String, subBatches: Seq[SubBatch]): WriteResult = {
    var pending = subBatches
    val accepted = Seq.newBuilder[String]
    var attempt = 0
    while (attempt < MaxAttempts && pending.nonEmpty) {
      attempt += 1
      try {
        // The batch id is the store's dedupe key: every attempt carries the same one.
        val reply = store.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).write(WriteRequest(batchId = batchId, subBatches = pending))
        accepted ++= reply.accepted
        val stored = reply.accepted.toSet
        // Only what the store did not take goes again: an accepted sub-batch is never re-sent.
        pending = pending.filterNot(sub => stored(sub.id))
      } catch {
        case _: StatusRuntimeException => () // nothing was acknowledged: the same sub-batches go again
      }
    }
    WriteResult(pending.isEmpty, accepted.result(), pending.map(_.id))
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

#include "telemetry_ingest.grpc.pb.h"

auto store = tsdb::TimeSeries::NewStub(grpc::CreateChannel("tsdb:9000", grpc::InsecureChannelCredentials()));

// A batch reported by sub-batch id.
struct WriteResult {
  bool complete = false;
  std::vector<std::string> accepted;
  std::vector<std::string> failed;
};

// Store every sub-batch of one WAL batch.
WriteResult writeBatch(const std::string& batch_id, const std::vector<tsdb::SubBatch>& sub_batches) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  tsdb::WriteRequest request;
  for (const auto& sub : sub_batches) *request.add_sub_batches() = sub;
  for (;;) {
    grpc::ClientContext ctx;
    tsdb::WriteReply reply;
    if (!store->Write(&ctx, request, &reply).ok()) {
      std::this_thread::sleep_for(std::chrono::seconds{1});  // the store is busy: try again
      continue;
    }
    if (reply.accepted_size() > 0) {
      return {true, {reply.accepted().begin(), reply.accepted().end()}, {reply.failed().begin(), reply.failed().end()}};
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <string>
#include <vector>

#include "telemetry_ingest.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{4};
constexpr int kMaxAttempts = 3;

auto store = tsdb::TimeSeries::NewStub(grpc::CreateChannel("tsdb:9000", grpc::InsecureChannelCredentials()));

// A batch reported by sub-batch id.
struct WriteResult {
  bool complete = false;
  std::vector<std::string> accepted;
  std::vector<std::string> failed;
};

// Store every sub-batch of one WAL batch.
WriteResult writeBatch(const std::string& batch_id, const std::vector<tsdb::SubBatch>& sub_batches) {
  std::vector<tsdb::SubBatch> pending = sub_batches;
  std::vector<std::string> accepted;
  for (int attempt = 0; attempt < kMaxAttempts && !pending.empty(); attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    tsdb::WriteRequest request;
    request.set_batch_id(batch_id);  // the store's dedupe key: every attempt carries the same one
    for (const auto& sub : pending) *request.add_sub_batches() = sub;
    tsdb::WriteReply reply;
    if (!store->Write(&ctx, request, &reply).ok()) continue;  // nothing was acknowledged: the same sub-batches go again
    accepted.insert(accepted.end(), reply.accepted().begin(), reply.accepted().end());
    const std::set<std::string> stored(reply.accepted().begin(), reply.accepted().end());
    // Only what the store did not take goes again: an accepted sub-batch is never re-sent.
    std::vector<tsdb::SubBatch> next;
    for (const auto& sub : pending) {
      if (stored.find(sub.id()) == stored.end()) next.push_back(sub);
    }
    pending = next;
  }
  std::vector<std::string> failed;
  for (const auto& sub : pending) failed.push_back(sub.id());
  return {pending.empty(), accepted, failed};
}
`,
    },
  },
  harness: {
    python: `import grpc

import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc


class Store(telemetry_ingest_pb2_grpc.TimeSeriesServicer):
    """Accepts every sub-batch but those in failing (id → how many more attempts it fails); down answers UNAVAILABLE for that many calls."""

    def __init__(self):
        self.failing = {}
        self.down = 0
        self.stored = {}

    def Write(self, request, context):
        if self.down > 0:
            self.down -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "the store is restarting")
        accepted, failed = [], []
        for sub in request.sub_batches:
            if self.failing.get(sub.id, 0) > 0:
                self.failing[sub.id] -= 1
                failed.append(sub.id)
            else:
                self.stored[sub.id] = self.stored.get(sub.id, 0) + 1
                accepted.append(sub.id)
        return telemetry_ingest_pb2.WriteReply(accepted=accepted, failed=failed)


def _subs():
    return [
        telemetry_ingest_pb2.SubBatch(id=f"s{i}", device_id="d-1", points=[telemetry_ingest_pb2.Point(metric="temp_c", value=20.0 + i, ts=1_800_000_000 + i)])
        for i in (1, 2, 3)
    ]


def _client(ctx):
    store = Store()
    ctx.grpc.serve(telemetry_ingest_pb2_grpc.add_TimeSeriesServicer_to_server, store)
    return ctx.load("client"), store


def _sent(ctx):
    return [[sub.id for sub in call.request.sub_batches] for call in ctx.grpc.calls_to("Write")]


def check_deadline(ctx):
    m, _ = _client(ctx)
    result = m.write_batch("b-1", _subs())
    assert result["complete"] is True, f"with a healthy store the batch must be complete, got {result}"
    calls = ctx.grpc.calls_to("Write")
    assert calls, "write_batch made no Write call"
    for call in calls:
        assert call.timeout is not None, "a Write call carries no deadline: a stalled store holds the writer for as long as it stalls"
        assert 3.5 <= call.timeout <= 4.5, f"a Write call carries a {call.timeout} s deadline, expected DEADLINE_S = 4"
    ctx.grpc.set_latency("Write", 30.0)
    before = ctx.clock.time()
    stalled = m.write_batch("b-2", _subs())
    waited = ctx.clock.time() - before
    assert stalled["complete"] is False, f"against a store that answers in 30 s the batch must be incomplete, got {stalled}"
    assert waited <= 13, f"write_batch waited {waited:.0f} s on a stalled store, expected at most three 4-second deadlines"


def check_bounded_attempts(ctx):
    m, store = _client(ctx)
    store.down = 6
    result = m.write_batch("b-1", _subs())
    calls = len(ctx.grpc.calls_to("Write"))
    assert calls == 3, f"with the store down write_batch made {calls} Write calls, expected MAX_ATTEMPTS = 3: a retry without a bound turns an outage into a loop"
    assert result["complete"] is False, f"after three failed attempts the batch must be incomplete, got {result}"
    assert sorted(result["failed"]) == ["s1", "s2", "s3"], f"failed must list every sub-batch still pending, got {result['failed']}"


def check_failed_only(ctx):
    m, store = _client(ctx)
    store.failing["s3"] = 2
    result = m.write_batch("b-1", _subs())
    sent = _sent(ctx)
    assert sent == [["s1", "s2", "s3"], ["s3"], ["s3"]], f"the Write requests carried {sent}: after the first reply only s3 was pending, so only s3 may be sent again"
    assert store.stored == {"s1": 1, "s2": 1, "s3": 1}, f"the store holds the sub-batches this many times: {store.stored}. A sub-batch it accepted was sent again"
    assert result["complete"] is True and sorted(result["accepted"]) == ["s1", "s2", "s3"], f"once s3 is stored the batch is complete, got {result}"


def check_batch_id(ctx):
    m, store = _client(ctx)
    store.failing["s2"] = 1
    m.write_batch("b-7", _subs())
    ids = [call.request.batch_id for call in ctx.grpc.calls_to("Write")]
    assert ids and all(i == "b-7" for i in ids), f"the Write requests carried batch ids {ids}: every attempt must carry the caller's b-7, the key the store dedupes on"
    assert len(ids) == 2, f"s2 failed once, so the batch takes two attempts; write_batch made {len(ids)}"


def check_done_all(ctx):
    m, store = _client(ctx)
    store.failing["s3"] = 99
    result = m.write_batch("b-1", _subs())
    assert result["complete"] is False, f"s3 failed on every attempt and write_batch answered {result}: a batch is complete only when every sub-batch is stored"
    assert sorted(result["accepted"]) == ["s1", "s2"] and result["failed"] == ["s3"], f"accepted must be s1 and s2 and failed s3, got {result}"
`,
    typescript: `const subs = () =>
  [1, 2, 3].map(i => ({id: \`s\${i}\`, device_id: 'd-1', points: [{metric: 'temp_c', value: 20 + i, ts: 1_800_000_000 + i}]}));

/** The store: accepts every sub-batch but those in failing (id → attempts it still fails); down answers UNAVAILABLE for that many calls. */
function client(ctx) {
  const pkg = ctx.proto('telemetry_ingest.proto');
  const peer = {failing: new Map<string, number>(), down: 0, stored: new Map<string, number>()};
  ctx.grpc.serve(pkg.tsdb.TimeSeries.service, {
    Write(call, callback) {
      if (peer.down > 0) {
        peer.down -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'the store is restarting'});
      }
      const accepted: string[] = [];
      const failed: string[] = [];
      for (const sub of call.request.sub_batches) {
        const left = peer.failing.get(sub.id) ?? 0;
        if (left > 0) {
          peer.failing.set(sub.id, left - 1);
          failed.push(sub.id);
        } else {
          peer.stored.set(sub.id, (peer.stored.get(sub.id) ?? 0) + 1);
          accepted.push(sub.id);
        }
      }
      callback(null, {accepted, failed});
    },
  });
  return {m: ctx.load('client'), peer};
}

const sent = ctx => ctx.grpc.callsTo('Write').map(call => call.request.sub_batches.map(sub => sub.id));

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const result = await m.writeBatch('b-1', subs());
  assert.equal(result.complete, true, \`with a healthy store the batch must be complete, got \${JSON.stringify(result)}\`);
  const calls = ctx.grpc.callsTo('Write');
  assert(calls.length > 0, 'writeBatch made no Write call');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Write call carries no deadline: a stalled store holds the writer for as long as it stalls');
    assert(call.timeout >= 3.5 && call.timeout <= 4.5, \`a Write call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 4000\`);
  }
  ctx.grpc.setLatency('Write', 30.0);
  const before = ctx.clock.now();
  const stalled = await m.writeBatch('b-2', subs());
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(stalled.complete, false, \`against a store that answers in 30 s the batch must be incomplete, got \${JSON.stringify(stalled)}\`);
  assert(waited <= 13, \`writeBatch waited \${waited.toFixed(0)} s on a stalled store, expected at most three 4-second deadlines\`);
}

export async function check_bounded_attempts(ctx) {
  const {m, peer} = client(ctx);
  peer.down = 6;
  const result = await m.writeBatch('b-1', subs());
  const calls = ctx.grpc.callsTo('Write').length;
  assert.equal(calls, 3, \`with the store down writeBatch made \${calls} Write calls, expected MAX_ATTEMPTS = 3: a retry without a bound turns an outage into a loop\`);
  assert.equal(result.complete, false, \`after three failed attempts the batch must be incomplete, got \${JSON.stringify(result)}\`);
  assert.deepEqual([...result.failed].sort(), ['s1', 's2', 's3'], \`failed must list every sub-batch still pending, got \${JSON.stringify(result.failed)}\`);
}

export async function check_failed_only(ctx) {
  const {m, peer} = client(ctx);
  peer.failing.set('s3', 2);
  const result = await m.writeBatch('b-1', subs());
  const requests = sent(ctx);
  assert.deepEqual(requests, [['s1', 's2', 's3'], ['s3'], ['s3']], \`the Write requests carried \${JSON.stringify(requests)}: after the first reply only s3 was pending, so only s3 may be sent again\`);
  const stored = Object.fromEntries(peer.stored);
  assert.deepEqual(stored, {s1: 1, s2: 1, s3: 1}, \`the store holds the sub-batches this many times: \${JSON.stringify(stored)}. A sub-batch it accepted was sent again\`);
  assert(result.complete === true && [...result.accepted].sort().join() === 's1,s2,s3', \`once s3 is stored the batch is complete, got \${JSON.stringify(result)}\`);
}

export async function check_batch_id(ctx) {
  const {m, peer} = client(ctx);
  peer.failing.set('s2', 1);
  await m.writeBatch('b-7', subs());
  const ids = ctx.grpc.callsTo('Write').map(call => call.request.batch_id);
  assert(ids.length > 0 && ids.every(id => id === 'b-7'), \`the Write requests carried batch ids \${JSON.stringify(ids)}: every attempt must carry the caller's b-7, the key the store dedupes on\`);
  assert.equal(ids.length, 2, \`s2 failed once, so the batch takes two attempts; writeBatch made \${ids.length}\`);
}

export async function check_done_all(ctx) {
  const {m, peer} = client(ctx);
  peer.failing.set('s3', 99);
  const result = await m.writeBatch('b-1', subs());
  assert.equal(result.complete, false, \`s3 failed on every attempt and writeBatch answered \${JSON.stringify(result)}: a batch is complete only when every sub-batch is stored\`);
  assert([...result.accepted].sort().join() === 's1,s2' && result.failed.join() === 's3', \`accepted must be s1 and s2 and failed s3, got \${JSON.stringify(result)}\`);
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

	pb "tsdb/gen/telemetry_ingest"

	"leetbuild/harness"
)

// seriesPeer accepts every sub-batch but those in failing (id → attempts it still fails); down
// answers Unavailable for that many calls.
type seriesPeer struct {
	pb.UnimplementedTimeSeriesServer
	failing map[string]int
	down    int
	stored  map[string]int
}

func (p *seriesPeer) Write(_ context.Context, req *pb.WriteRequest) (*pb.WriteReply, error) {
	if p.down > 0 {
		p.down--
		return nil, status.Error(codes.Unavailable, "the store is restarting")
	}
	reply := &pb.WriteReply{}
	for _, sub := range req.GetSubBatches() {
		if p.failing[sub.GetId()] > 0 {
			p.failing[sub.GetId()]--
			reply.Failed = append(reply.Failed, sub.GetId())
			continue
		}
		p.stored[sub.GetId()]++
		reply.Accepted = append(reply.Accepted, sub.GetId())
	}
	return reply, nil
}

func peerFor(ctx *harness.Ctx) *seriesPeer {
	peer := &seriesPeer{failing: map[string]int{}, stored: map[string]int{}}
	pb.RegisterTimeSeriesServer(ctx.GRPC.Server(""), peer)
	return peer
}

func threeSubs() []*pb.SubBatch {
	var out []*pb.SubBatch
	for i := 1; i <= 3; i++ {
		out = append(out, &pb.SubBatch{Id: fmt.Sprintf("s%d", i), DeviceId: "d-1", Points: []*pb.Point{{Metric: "temp_c", Value: 20 + float64(i), Ts: 1_800_000_000 + int64(i)}}})
	}
	return out
}

func sentIDs(ctx *harness.Ctx) [][]string {
	var out [][]string
	for _, call := range ctx.GRPC.CallsTo("Write", "") {
		var ids []string
		for _, sub := range call.Request.(*pb.WriteRequest).GetSubBatches() {
			ids = append(ids, sub.GetId())
		}
		out = append(out, ids)
	}
	return out
}

func sortedIDs(ids []string) []string {
	out := append([]string{}, ids...)
	sort.Strings(out)
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	peerFor(ctx)
	result := writeBatch(context.Background(), "b-1", threeSubs())
	ctx.Assert(result.Complete, "with a healthy store the batch must be complete, got %+v", result)
	calls := ctx.GRPC.CallsTo("Write", "")
	ctx.Assert(len(calls) > 0, "writeBatch made no Write call")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Write call carries no deadline: a stalled store holds the writer for as long as it stalls")
		ctx.Assert(3500*time.Millisecond <= call.Timeout && call.Timeout <= 4500*time.Millisecond, "a Write call carries a %v deadline, expected 4 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Write", 30.0, "")
	before := ctx.Clock.Now()
	stalled := writeBatch(context.Background(), "b-2", threeSubs())
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(!stalled.Complete, "against a store that answers in 30 s the batch must be incomplete, got %+v", stalled)
	ctx.Assert(waited <= 13, "writeBatch waited %.0f s on a stalled store, expected at most three 4-second deadlines", waited)
}

func CheckBoundedAttempts(ctx *harness.Ctx) {
	peer := peerFor(ctx)
	peer.down = 6
	result := writeBatch(context.Background(), "b-1", threeSubs())
	calls := len(ctx.GRPC.CallsTo("Write", ""))
	ctx.Assert(calls == 3, "with the store down writeBatch made %d Write calls, expected maxAttempts = 3: a retry without a bound turns an outage into a loop", calls)
	ctx.Assert(!result.Complete, "after three failed attempts the batch must be incomplete, got %+v", result)
	ctx.Equal(sortedIDs(result.Failed), []string{"s1", "s2", "s3"}, "Failed must list every sub-batch still pending")
}

func CheckFailedOnly(ctx *harness.Ctx) {
	peer := peerFor(ctx)
	peer.failing["s3"] = 2
	result := writeBatch(context.Background(), "b-1", threeSubs())
	sent := sentIDs(ctx)
	ctx.Equal(sent, [][]string{{"s1", "s2", "s3"}, {"s3"}, {"s3"}}, "after the first reply only s3 was pending, so only s3 may be sent again; the Write requests carried")
	ctx.Equal(peer.stored, map[string]int{"s1": 1, "s2": 1, "s3": 1}, "a sub-batch the store accepted must not be sent again; the store holds them this many times")
	ctx.Assert(result.Complete && len(result.Accepted) == 3, "once s3 is stored the batch is complete, got %+v", result)
}

func CheckBatchId(ctx *harness.Ctx) {
	peer := peerFor(ctx)
	peer.failing["s2"] = 1
	writeBatch(context.Background(), "b-7", threeSubs())
	var ids []string
	for _, call := range ctx.GRPC.CallsTo("Write", "") {
		ids = append(ids, call.Request.(*pb.WriteRequest).GetBatchId())
	}
	for _, id := range ids {
		ctx.Assert(id == "b-7", "the Write requests carried batch ids %q: every attempt must carry the caller's b-7, the key the store dedupes on", ids)
	}
	ctx.Equal(len(ids), 2, "s2 failed once, so the batch takes two attempts; the Write calls")
}

func CheckDoneAll(ctx *harness.Ctx) {
	peer := peerFor(ctx)
	peer.failing["s3"] = 99
	result := writeBatch(context.Background(), "b-1", threeSubs())
	ctx.Assert(!result.Complete, "s3 failed on every attempt and writeBatch answered %+v: a batch is complete only when every sub-batch is stored", result)
	ctx.Equal(sortedIDs(result.Accepted), []string{"s1", "s2"}, "Accepted")
	ctx.Equal(result.Failed, []string{"s3"}, "Failed")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "telemetry_ingest.grpc.pb.h"

namespace {

// Accepts every sub-batch but those in failing (id → attempts it still fails); down answers
// UNAVAILABLE for that many calls.
class SeriesPeer final : public tsdb::TimeSeries::Service {
 public:
  std::map<std::string, int> failing;
  int down = 0;
  std::map<std::string, int> stored;

  grpc::Status Write(grpc::ServerContext*, const tsdb::WriteRequest* req, tsdb::WriteReply* out) override {
    if (down > 0) {
      down--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "the store is restarting");
    }
    for (const auto& sub : req->sub_batches()) {
      if (failing[sub.id()] > 0) {
        failing[sub.id()]--;
        out->add_failed(sub.id());
        continue;
      }
      stored[sub.id()]++;
      out->add_accepted(sub.id());
    }
    return grpc::Status::OK;
  }
};

SeriesPeer& peerFor(harness::Ctx& ctx) {
  static SeriesPeer* peer = nullptr;
  delete peer;
  peer = new SeriesPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::vector<tsdb::SubBatch> threeSubs() {
  std::vector<tsdb::SubBatch> out;
  for (int i = 1; i <= 3; i++) {
    tsdb::SubBatch sub;
    sub.set_id("s" + std::to_string(i));
    sub.set_device_id("d-1");
    tsdb::Point* point = sub.add_points();
    point->set_metric("temp_c");
    point->set_value(20 + i);
    point->set_ts(1800000000LL + i);
    out.push_back(sub);
  }
  return out;
}

std::vector<std::vector<std::string>> sentIds(harness::Ctx& ctx) {
  std::vector<std::vector<std::string>> out;
  for (const auto& call : ctx.GRPC.CallsTo("Write")) {
    std::vector<std::string> ids;
    const tsdb::WriteRequest request = call.Request<tsdb::WriteRequest>();
    for (const auto& sub : request.sub_batches()) ids.push_back(sub.id());
    out.push_back(ids);
  }
  return out;
}

std::vector<std::string> sortedIds(std::vector<std::string> ids) {
  std::sort(ids.begin(), ids.end());
  return ids;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  peerFor(ctx);
  const WriteResult result = writeBatch("b-1", threeSubs());
  ctx.Assert(result.complete, "with a healthy store the batch must be complete");
  const auto calls = ctx.GRPC.CallsTo("Write");
  ctx.Assert(!calls.empty(), "writeBatch made no Write call");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Write call carries no deadline: a stalled store holds the writer for as long as it stalls");
    ctx.Assert(3.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 4.5, "a Write call carries a %v s deadline, expected kDeadline = 4 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Write", 30.0);
  const long long before = ctx.Clock.Now();
  const WriteResult stalled = writeBatch("b-2", threeSubs());
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(!stalled.complete, "against a store that answers in 30 s the batch must be incomplete");
  ctx.Assert(waited <= 13, "writeBatch waited %.0f s on a stalled store, expected at most three 4-second deadlines", waited);
}

void CheckBoundedAttempts(harness::Ctx& ctx) {
  SeriesPeer& peer = peerFor(ctx);
  peer.down = 6;
  const WriteResult result = writeBatch("b-1", threeSubs());
  const size_t calls = ctx.GRPC.CallsTo("Write").size();
  ctx.Assert(calls == 3, "with the store down writeBatch made %d Write calls, expected kMaxAttempts = 3: a retry without a bound turns an outage into a loop", calls);
  ctx.Assert(!result.complete, "after three failed attempts the batch must be incomplete");
  ctx.Equal(sortedIds(result.failed), {"s1", "s2", "s3"}, "failed must list every sub-batch still pending");
}

void CheckFailedOnly(harness::Ctx& ctx) {
  SeriesPeer& peer = peerFor(ctx);
  peer.failing["s3"] = 2;
  const WriteResult result = writeBatch("b-1", threeSubs());
  const std::vector<std::vector<std::string>> want = {{"s1", "s2", "s3"}, {"s3"}, {"s3"}};
  ctx.Equal(sentIds(ctx), want, "after the first reply only s3 was pending, so only s3 may be sent again; the Write requests carried");
  const std::map<std::string, int> once = {{"s1", 1}, {"s2", 1}, {"s3", 1}};
  ctx.Equal(peer.stored, once, "a sub-batch the store accepted must not be sent again; the store holds them this many times");
  ctx.Assert(result.complete && result.accepted.size() == 3, "once s3 is stored the batch is complete");
}

void CheckBatchId(harness::Ctx& ctx) {
  SeriesPeer& peer = peerFor(ctx);
  peer.failing["s2"] = 1;
  writeBatch("b-7", threeSubs());
  std::vector<std::string> ids;
  for (const auto& call : ctx.GRPC.CallsTo("Write")) ids.push_back(call.Request<tsdb::WriteRequest>().batch_id());
  for (const auto& id : ids) ctx.Assert(id == "b-7", "the Write requests carried batch ids %q: every attempt must carry the caller's b-7, the key the store dedupes on", ids);
  ctx.Equal(ids.size(), 2, "s2 failed once, so the batch takes two attempts; the Write calls");
}

void CheckDoneAll(harness::Ctx& ctx) {
  SeriesPeer& peer = peerFor(ctx);
  peer.failing["s3"] = 99;
  const WriteResult result = writeBatch("b-1", threeSubs());
  ctx.Assert(!result.complete, "s3 failed on every attempt and writeBatch answered complete: a batch is complete only when every sub-batch is stored");
  ctx.Equal(sortedIds(result.accepted), {"s1", "s2"}, "accepted");
  ctx.Equal(result.failed, {"s3"}, "failed");
}
`,
  },
  hints: [
    'Make the store accept two of three sub-batches: the writer reports the batch complete and the third never arrives. Take the store down: the writer never returns.',
    'Every request is built from the whole batch with no batch id, the loop has no bound and no deadline, and `len(reply.accepted) > 0` is read as "done" while `reply.failed` still names a sub-batch.',
    'Keep `pending`; send `WriteRequest(batch_id=batch_id, sub_batches=pending)` with `timeout=DEADLINE_S` inside `for _ in range(MAX_ATTEMPTS)`, drop the accepted ids from `pending` after each reply, and return complete only when `pending` is empty.',
  ],
  debrief: `A partial reply is the store telling the writer exactly what is left, so the retry set is the pending set and nothing else: resending an accepted sub-batch is a second write the store has no reason to refuse. The batch id gives the store a key to drop a replay it already applied, which covers the one case the writer cannot see, an attempt that landed but whose reply timed out. The deadline and the attempt bound turn an outage into a known cost, three times four seconds, after which the batch stays in the WAL for the next pass instead of holding a worker. Production writers add jittered backoff between attempts, cap the bytes in flight per shard, and tell a retryable status from a rejection the way Prometheus remote write does: a 5xx is retried, a 4xx is dropped and counted.`,
};
