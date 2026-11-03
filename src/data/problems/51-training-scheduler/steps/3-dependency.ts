import type {Step} from '@/lib/types';

export const trainingDependencyStep: Step = {
  id: 'dependency',
  title: 'Preemption that checkpoints before it kills',
  concept: 'grpc',
  file: 'preempt',
  focus: ['scheduler', 'worker', 'redis'],
  task: `## Task

**Starting point.** The starter is the scheduler's preemption call, \`preempt(run_id)\`: when
higher-priority work needs the GPUs it asks the run's worker (gRPC \`Worker\` at \`worker:9000\`) to
\`Terminate\` the job, then to \`Checkpoint\` it, records the checkpoint id with
\`runs.set_checkpoint\` and returns \`True\`. It frees the GPUs and hides four flaws.

**Failure mode the checks target.** Every preemption throws away hours of training, because the
process is gone before the checkpoint is asked for; a job that hangs while checkpointing holds the
scheduler as long as it likes; a job that cannot checkpoint is killed outright; and a preempted run
sits in no queue, so it never runs again.

\`\`\`proto
service Worker {
  rpc Checkpoint(CheckpointRequest) returns (CheckpointReply); // {supported, checkpoint_id}; NOT_FOUND: not running
  rpc Terminate(TerminateRequest) returns (TerminateReply);    // {run_id, reason}
}
\`\`\`

- Checkpoint first, with \`grace_s = GRACE_S\` (30) in the request and as the call's deadline; record
  the id, then \`Terminate\` with reason \`preempted\`.
- On \`DEADLINE_EXCEEDED\`, terminate anyway with reason \`grace_deadline_exceeded\`: the run keeps
  its previous checkpoint.
- \`supported = false\`: return \`False\`; the job keeps running and is not terminated.
- A preempted run goes back to the queue at its own position,
  \`queue.enqueue(run_id, run["band"], run["enqueued_at_ms"])\`, and \`preempt\` returns \`True\`.`,
  sequence: {
    participants: ['Scheduler', 'Worker', 'Redis queue'],
    messages: [
      {from: 'Scheduler', to: 'Worker', label: 'Checkpoint(run_id, grace_s = 30) · deadline 30 s', kind: 'sync'},
      {from: 'Worker', to: 'Scheduler', label: 'checkpoint_id · supported = false · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Scheduler', to: 'Scheduler', label: 'supported = false → keep running, return False', kind: 'sync'},
      {from: 'Scheduler', to: 'Worker', label: 'Terminate(run_id, preempted | grace_deadline_exceeded)', kind: 'sync'},
      {from: 'Scheduler', to: 'Redis queue', label: 'enqueue(run_id, band, enqueued_at_ms)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'checkpoint-first',
      title: 'Asks for the checkpoint before it terminates the job',
      detail:
        'The worker sees `Checkpoint` then `Terminate` (reason `preempted`), and the run row holds the checkpoint id the worker answered. The starter terminates first, so there is nothing left to checkpoint.',
      match: {
        python: {all: [/runs\.set_checkpoint\(/], order: [/worker\.Checkpoint\(/, /worker\.Terminate\(/]},
        typescript: {all: [/setCheckpoint\(/], order: [/worker\.Checkpoint\(/, /worker\.Terminate\(/]},
        go: {all: [/runs\.SetCheckpoint\(/], order: [/worker\.Checkpoint\(/, /worker\.Terminate\(/]},
        scala: {all: [/Runs\.setCheckpoint\(/], order: [/\.checkpoint\(/, /\.terminate\(/]},
        cpp: {all: [/runs::setCheckpoint\(/], order: [/worker->Checkpoint\(/, /worker->Terminate\(/]},
      },
    },
    {
      id: 'grace-deadline',
      title: 'Waits at most the grace period, then terminates anyway',
      detail:
        'The `Checkpoint` call carries a 30-second deadline; a job that does not answer in time is terminated with reason `grace_deadline_exceeded`, keeps its previous checkpoint and is queued again. The starter sets no deadline.',
      match: {
        python: {all: [/timeout\s*=\s*GRACE_S/, /DEADLINE_EXCEEDED/, /grace_deadline_exceeded/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*GRACE_S/, /DEADLINE_EXCEEDED/, /grace_deadline_exceeded/]},
        go: {all: [/context\.WithTimeout\([^\n]*graceS/, /codes\.DeadlineExceeded/, /grace_deadline_exceeded/]},
        scala: {all: [/withDeadlineAfter\(\s*GraceS/, /DEADLINE_EXCEEDED/, /grace_deadline_exceeded/]},
        cpp: {all: [/set_deadline\([^\n]*kGraceS/, /DEADLINE_EXCEEDED/, /grace_deadline_exceeded/]},
      },
    },
    {
      id: 'no-checkpoint-support',
      title: 'Leaves a job that cannot checkpoint running',
      detail:
        'A worker that answers `supported = false` gets no `Terminate`; `preempt` returns false and the run stays running. The starter kills it.',
      match: {
        python: {order: [/not reply\.supported/, /reason\s*=\s*["']preempted["']/]},
        typescript: {order: [/!reply\.supported/, /reason:\s*['"]preempted['"]/]},
        go: {order: [/!reply\.GetSupported\(\)|!reply\.Supported/, /Reason:\s*"preempted"/]},
        scala: {order: [/!reply\.supported/, /"preempted"/]},
        cpp: {order: [/!reply\.supported\(\)/, /"preempted"/]},
      },
    },
    {
      id: 'requeue-preempted',
      title: 'Queues a preempted run again at its own position',
      detail:
        'After a preemption the run waits in `training:queue` at its original score, ahead of a run of its band submitted later, with state `queued`. The starter leaves it in no queue.',
      match: {
        python: {all: [/queue\.enqueue\([^\n]*enqueued_at_ms/]},
        typescript: {all: [/enqueue\([^\n]*enqueued_at_ms/]},
        go: {all: [/queue\.Enqueue\([^\n]*EnqueuedAtMs/]},
        scala: {all: [/Queue\.enqueue\([^\n]*enqueuedAtMs/]},
        cpp: {all: [/queue::enqueue\([^\n]*enqueued_at_ms/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import queue, runs  # runs.get, set_checkpoint; queue.enqueue

GRACE_S = 30

worker = trainsched_pb2_grpc.WorkerStub(grpc.insecure_channel("worker:9000"))


def preempt(run_id: str) -> bool:
    """Make room on the GPUs the run holds."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    worker.Terminate(trainsched_pb2.TerminateRequest(run_id=run_id, reason="preempted"))
    reply = worker.Checkpoint(trainsched_pb2.CheckpointRequest(run_id=run_id, grace_s=GRACE_S))
    runs.set_checkpoint(run_id, reply.checkpoint_id)
    return True
`,
      solution: `import grpc

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import queue, runs  # runs.get, set_checkpoint; queue.enqueue

GRACE_S = 30

worker = trainsched_pb2_grpc.WorkerStub(grpc.insecure_channel("worker:9000"))


def preempt(run_id: str) -> bool:
    """Make room on the GPUs the run holds: checkpoint it, stop it, queue it again. False when it keeps running."""
    run = runs.get(run_id)
    try:
        # The job has GRACE_S to write its checkpoint, and the call waits no longer than that.
        reply = worker.Checkpoint(trainsched_pb2.CheckpointRequest(run_id=run_id, grace_s=GRACE_S), timeout=GRACE_S)
    except grpc.RpcError as exc:
        if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
            raise
        # Out of grace: stop it anyway; it resumes from the checkpoint it already had.
        worker.Terminate(trainsched_pb2.TerminateRequest(run_id=run_id, reason="grace_deadline_exceeded"))
        queue.enqueue(run_id, run["band"], run["enqueued_at_ms"])
        return True
    if not reply.supported:
        return False  # a job that cannot checkpoint keeps its GPUs
    runs.set_checkpoint(run_id, reply.checkpoint_id)
    worker.Terminate(trainsched_pb2.TerminateRequest(run_id=run_id, reason="preempted"))
    queue.enqueue(run_id, run["band"], run["enqueued_at_ms"])
    return True
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {enqueue} from 'trainsched/queue';
import {get, setCheckpoint} from 'trainsched/runs';

export const GRACE_S = 30;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trainsched.proto')) as unknown as {
  trainsched: {Worker: grpc.ServiceClientConstructor};
};
const worker = new pkg.trainsched.Worker('worker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Checkpoint(request: {run_id: string; grace_s: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{supported: boolean; checkpoint_id: string}>;
  Terminate(request: {run_id: string; reason: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<object>;
};

/** Make room on the GPUs the run holds. */
export async function preempt(runId: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await worker.Terminate({run_id: runId, reason: 'preempted'}, new grpc.Metadata(), {});
  const reply = await worker.Checkpoint({run_id: runId, grace_s: GRACE_S}, new grpc.Metadata(), {});
  await setCheckpoint(runId, reply.checkpoint_id);
  return true;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {enqueue} from 'trainsched/queue';
import {get, setCheckpoint} from 'trainsched/runs';

export const GRACE_S = 30;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trainsched.proto')) as unknown as {
  trainsched: {Worker: grpc.ServiceClientConstructor};
};
const worker = new pkg.trainsched.Worker('worker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Checkpoint(request: {run_id: string; grace_s: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{supported: boolean; checkpoint_id: string}>;
  Terminate(request: {run_id: string; reason: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<object>;
};

/** Make room on the GPUs the run holds: checkpoint it, stop it, queue it again. False when it keeps running. */
export async function preempt(runId: string): Promise<boolean> {
  const run = await get(runId);
  if (run === null) throw new Error(\`no run \${runId}\`);
  let reply: {supported: boolean; checkpoint_id: string};
  try {
    // The job has GRACE_S to write its checkpoint, and the call waits no longer than that.
    reply = await worker.Checkpoint({run_id: runId, grace_s: GRACE_S}, new grpc.Metadata(), {deadline: Date.now() + GRACE_S * 1000});
  } catch (e) {
    if ((e as grpc.ServiceError).code !== grpc.status.DEADLINE_EXCEEDED) throw e;
    // Out of grace: stop it anyway; it resumes from the checkpoint it already had.
    await worker.Terminate({run_id: runId, reason: 'grace_deadline_exceeded'}, new grpc.Metadata(), {});
    await enqueue(runId, run.band, run.enqueued_at_ms);
    return true;
  }
  if (!reply.supported) return false; // a job that cannot checkpoint keeps its GPUs
  await setCheckpoint(runId, reply.checkpoint_id);
  await worker.Terminate({run_id: runId, reason: 'preempted'}, new grpc.Metadata(), {});
  await enqueue(runId, run.band, run.enqueued_at_ms);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "trainsched/gen/trainsched"
	"trainsched/runs" // runs.Get, SetCheckpoint
)

const graceS = 30

var (
	workerConn, _ = grpc.NewClient("worker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	worker        = pb.NewWorkerClient(workerConn)
)

// preempt makes room on the GPUs the run holds.
func preempt(ctx context.Context, runID string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if _, err := worker.Terminate(ctx, &pb.TerminateRequest{RunId: runID, Reason: "preempted"}); err != nil {
		return false, err
	}
	reply, err := worker.Checkpoint(ctx, &pb.CheckpointRequest{RunId: runID, GraceS: graceS})
	if err != nil {
		return false, err
	}
	return true, runs.SetCheckpoint(ctx, runID, reply.GetCheckpointId())
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "trainsched/gen/trainsched"
	"trainsched/queue" // queue.Enqueue
	"trainsched/runs"  // runs.Get, SetCheckpoint
)

const graceS = 30

var (
	workerConn, _ = grpc.NewClient("worker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	worker        = pb.NewWorkerClient(workerConn)
)

// preempt makes room on the GPUs the run holds: it checkpoints the run, stops it and queues it
// again; false when the run keeps running.
func preempt(ctx context.Context, runID string) (bool, error) {
	run := runs.Get(ctx, runID)
	if run == nil {
		return false, fmt.Errorf("no run %s", runID)
	}
	// The job has graceS to write its checkpoint, and the call waits no longer than that.
	callCtx, cancel := context.WithTimeout(ctx, graceS*time.Second)
	reply, err := worker.Checkpoint(callCtx, &pb.CheckpointRequest{RunId: runID, GraceS: graceS})
	cancel()
	if status.Code(err) == codes.DeadlineExceeded {
		// Out of grace: stop it anyway; it resumes from the checkpoint it already had.
		if _, err := worker.Terminate(ctx, &pb.TerminateRequest{RunId: runID, Reason: "grace_deadline_exceeded"}); err != nil {
			return false, err
		}
		return true, queue.Enqueue(ctx, runID, run.Band, run.EnqueuedAtMs)
	}
	if err != nil {
		return false, err
	}
	if !reply.GetSupported() {
		return false, nil // a job that cannot checkpoint keeps its GPUs
	}
	if err := runs.SetCheckpoint(ctx, runID, reply.GetCheckpointId()); err != nil {
		return false, err
	}
	if _, err := worker.Terminate(ctx, &pb.TerminateRequest{RunId: runID, Reason: "preempted"}); err != nil {
		return false, err
	}
	return true, queue.Enqueue(ctx, runID, run.Band, run.EnqueuedAtMs)
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import trainsched.{Queue, Runs} // Runs.get, setCheckpoint; Queue.enqueue
import trainsched.trainsched.{CheckpointRequest, TerminateRequest, WorkerGrpc}

object Preemption {
  val GraceS = 30

  private val worker = WorkerGrpc.blockingStub(ManagedChannelBuilder.forAddress("worker", 9000).usePlaintext().build())

  /** Make room on the GPUs the run holds. */
  def preempt(runId: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    worker.terminate(TerminateRequest(runId = runId, reason = "preempted"))
    val reply = worker.checkpoint(CheckpointRequest(runId = runId, graceS = GraceS))
    Runs.setCheckpoint(runId, reply.checkpointId)
    true
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import trainsched.{Queue, Runs} // Runs.get, setCheckpoint; Queue.enqueue
import trainsched.trainsched.{CheckpointRequest, TerminateRequest, WorkerGrpc}

object Preemption {
  val GraceS = 30

  private val worker = WorkerGrpc.blockingStub(ManagedChannelBuilder.forAddress("worker", 9000).usePlaintext().build())

  /** Make room on the GPUs the run holds: checkpoint it, stop it, queue it again. False when it keeps running. */
  def preempt(runId: String): Boolean = {
    val run = Runs.get(runId).getOrElse(throw new NoSuchElementException(s"no run $runId"))
    // The job has GraceS to write its checkpoint, and the call waits no longer than that.
    val reply =
      try Some(worker.withDeadlineAfter(GraceS, TimeUnit.SECONDS).checkpoint(CheckpointRequest(runId = runId, graceS = GraceS)))
      catch { case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED => None }
    reply match {
      case None =>
        // Out of grace: stop it anyway; it resumes from the checkpoint it already had.
        worker.terminate(TerminateRequest(runId = runId, reason = "grace_deadline_exceeded"))
        Queue.enqueue(runId, run.band, run.enqueuedAtMs)
        true
      case Some(reply) if !reply.supported => false // a job that cannot checkpoint keeps its GPUs
      case Some(reply) =>
        Runs.setCheckpoint(runId, reply.checkpointId)
        worker.terminate(TerminateRequest(runId = runId, reason = "preempted"))
        Queue.enqueue(runId, run.band, run.enqueuedAtMs)
        true
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "trainsched.grpc.pb.h"
#include "trainsched/queue.h"  // queue::enqueue
#include "trainsched/runs.h"   // runs::get, setCheckpoint

constexpr int kGraceS = 30;

auto worker = trainsched::Worker::NewStub(grpc::CreateChannel("worker:9000", grpc::InsecureChannelCredentials()));

// Make room on the GPUs the run holds.
bool preempt(const std::string& run_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  grpc::ClientContext stop_ctx;
  trainsched::TerminateRequest stop;
  stop.set_run_id(run_id);
  stop.set_reason("preempted");
  trainsched::TerminateReply stopped;
  const grpc::Status stop_status = worker->Terminate(&stop_ctx, stop, &stopped);
  if (!stop_status.ok()) throw std::runtime_error("terminate: " + stop_status.error_message());
  grpc::ClientContext ctx;
  trainsched::CheckpointRequest request;
  request.set_run_id(run_id);
  request.set_grace_s(kGraceS);
  trainsched::CheckpointReply reply;
  const grpc::Status status = worker->Checkpoint(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("checkpoint: " + status.error_message());
  runs::setCheckpoint(run_id, reply.checkpoint_id());
  return true;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "trainsched.grpc.pb.h"
#include "trainsched/queue.h"  // queue::enqueue
#include "trainsched/runs.h"   // runs::get, setCheckpoint

constexpr int kGraceS = 30;

auto worker = trainsched::Worker::NewStub(grpc::CreateChannel("worker:9000", grpc::InsecureChannelCredentials()));

// Make room on the GPUs the run holds: checkpoint it, stop it, queue it again. False when it keeps running.
bool preempt(const std::string& run_id) {
  const auto run = runs::get(run_id);
  if (!run) throw std::runtime_error("no run " + run_id);
  // The job has kGraceS to write its checkpoint, and the call waits no longer than that.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{kGraceS});
  trainsched::CheckpointRequest request;
  request.set_run_id(run_id);
  request.set_grace_s(kGraceS);
  trainsched::CheckpointReply reply;
  const grpc::Status status = worker->Checkpoint(&ctx, request, &reply);
  const bool out_of_grace = status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
  if (!status.ok() && !out_of_grace) throw std::runtime_error("checkpoint: " + status.error_message());
  if (status.ok() && !reply.supported()) return false;  // a job that cannot checkpoint keeps its GPUs
  // Out of grace: stop it anyway; it resumes from the checkpoint it already had.
  if (status.ok()) runs::setCheckpoint(run_id, reply.checkpoint_id());
  grpc::ClientContext stop_ctx;
  trainsched::TerminateRequest stop;
  stop.set_run_id(run_id);
  stop.set_reason(out_of_grace ? "grace_deadline_exceeded" : "preempted");
  trainsched::TerminateReply stopped;
  const grpc::Status stop_status = worker->Terminate(&stop_ctx, stop, &stopped);
  if (!stop_status.ok()) throw std::runtime_error("terminate: " + stop_status.error_message());
  queue::enqueue(run_id, run->band, run->enqueued_at_ms);
  return true;
}
`,
    },
  },
  harness: {
    python: `import grpc

import trainsched_pb2
import trainsched_pb2_grpc
from trainsched import queue, runs


class Worker(trainsched_pb2_grpc.WorkerServicer):
    """A worker agent: the jobs in running write a checkpoint when asked, except those in no_checkpoint."""

    def __init__(self):
        self.running = set()
        self.no_checkpoint = set()
        self.saved = 0

    def Checkpoint(self, request, context):
        if request.run_id not in self.running:
            context.abort(grpc.StatusCode.NOT_FOUND, f"run {request.run_id} is not running: there is nothing left to checkpoint")
        if request.run_id in self.no_checkpoint:
            return trainsched_pb2.CheckpointReply(supported=False)
        self.saved += 1
        return trainsched_pb2.CheckpointReply(supported=True, checkpoint_id=f"ckpt-{request.run_id}-{self.saved}")

    def Terminate(self, request, context):
        self.running.discard(request.run_id)
        return trainsched_pb2.TerminateReply()


def _setup(ctx):
    worker = Worker()
    ctx.grpc.serve(trainsched_pb2_grpc.add_WorkerServicer_to_server, worker)
    return ctx.load("preempt"), worker, int(ctx.clock.time() * 1000)


def _running(worker, run_id, band, at):
    runs.put({"run_id": run_id, "tenant": "t1", "recipe_version": "llama-ft-v3", "dataset_version": "ds-1", "priority": 8 - 3 * band,
              "band": band, "state": "running", "enqueued_at_ms": at, "worker": "w-1", "nodes": ["n1", "n2"], "checkpoint_id": "ckpt-old"})
    worker.running.add(run_id)


def _preempt(m, run_id):
    try:
        return m.preempt(run_id)
    except grpc.RpcError as exc:
        raise AssertionError(f"preempt({run_id!r}) raised {exc.code().name}: {exc.details()}") from None


def _methods(ctx):
    return [c.method for c in ctx.grpc.calls if c.method in ("Checkpoint", "Terminate")]


def check_checkpoint_first(ctx):
    m, worker, t0 = _setup(ctx)
    _running(worker, "run-a", 1, t0)
    assert _preempt(m, "run-a") is True, "a job that checkpointed must be preempted (True)"
    assert _methods(ctx) == ["Checkpoint", "Terminate"], f"the worker was called {_methods(ctx)}: ask for the checkpoint, wait for its id, then terminate"
    run = runs.get("run-a")
    assert run["checkpoint_id"] == "ckpt-run-a-1", f"the run row holds checkpoint {run['checkpoint_id']!r}, the worker answered ckpt-run-a-1"
    reason = ctx.grpc.calls_to("Terminate")[0].request.reason
    assert reason == "preempted", f"the Terminate carried reason {reason!r}, expected preempted"


def check_grace_deadline(ctx):
    m, worker, t0 = _setup(ctx)
    _running(worker, "run-a", 1, t0)
    ctx.grpc.set_latency("Checkpoint", 120.0)  # the job hangs while it writes its checkpoint
    before = ctx.clock.time()
    assert _preempt(m, "run-a") is True, "a job that ran out of grace must still be preempted (True)"
    waited = ctx.clock.time() - before
    call = ctx.grpc.calls_to("Checkpoint")[0]
    assert call.timeout is not None and 29 <= call.timeout <= 31, f"the Checkpoint call carried a deadline of {call.timeout} s, expected GRACE_S = 30"
    assert waited <= 31, f"preempt waited {waited:.0f} s for a job that never finished its checkpoint: wait GRACE_S at most"
    reasons = [c.request.reason for c in ctx.grpc.calls_to("Terminate")]
    assert reasons == ["grace_deadline_exceeded"], f"the worker got Terminate with reasons {reasons}, expected one with grace_deadline_exceeded"
    run = runs.get("run-a")
    assert run["checkpoint_id"] == "ckpt-old", f"the run's checkpoint became {run['checkpoint_id']!r}: it resumes from the one it had (ckpt-old)"
    assert ctx.redis.zscore("training:queue", "run-a") is not None, "a run preempted on the deadline path must be queued again"


def check_no_checkpoint_support(ctx):
    m, worker, t0 = _setup(ctx)
    _running(worker, "run-a", 1, t0)
    worker.no_checkpoint.add("run-a")
    result = _preempt(m, "run-a")
    assert result is False, f"preempt returned {result!r} for a job that cannot checkpoint, expected False"
    assert ctx.grpc.calls_to("Terminate") == [], "a job that cannot checkpoint was terminated: its training since the start is lost. Leave it running"
    assert "run-a" in worker.running, "the job is no longer running on the worker"
    assert runs.get("run-a")["state"] == "running", f"the run row reads {runs.get('run-a')['state']!r}, expected running"
    assert ctx.redis.zscore("training:queue", "run-a") is None, "a run that keeps running must not also be queued"


def check_requeue_preempted(ctx):
    m, worker, t0 = _setup(ctx)
    _running(worker, "run-a", 1, t0)
    runs.put({"run_id": "run-b", "tenant": "t1", "recipe_version": "llama-ft-v3", "dataset_version": "ds-1", "priority": 5,
              "band": 1, "state": "queued", "enqueued_at_ms": t0 + 5000})
    queue.enqueue("run-b", 1, t0 + 5000)
    assert _preempt(m, "run-a") is True, "a job that checkpointed must be preempted (True)"
    score = ctx.redis.zscore("training:queue", "run-a")
    assert score == queue.position_score(1, t0), f"run-a waits with score {score}, expected its own position {queue.position_score(1, t0)}: a preempted run must not vanish or lose its place"
    assert runs.get("run-a")["state"] == "queued", f"the preempted run reads {runs.get('run-a')['state']!r}, expected queued"
    head = queue.claim_next("w-2", t0 + 6000)
    assert head == "run-a", f"the next claim got {head}: run-a was submitted before run-b and resumes first"
`,
    typescript: `function setup(ctx) {
  const pkg = ctx.proto('trainsched.proto');
  const worker = {running: new Set<string>(), noCheckpoint: new Set<string>(), saved: 0, log: [] as string[]};
  ctx.grpc.serve(pkg.trainsched.Worker.service, {
    Checkpoint(call, callback) {
      const {run_id} = call.request;
      worker.log.push('Checkpoint');
      if (!worker.running.has(run_id)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`run \${run_id} is not running: there is nothing left to checkpoint\`});
      if (worker.noCheckpoint.has(run_id)) return callback(null, {supported: false, checkpoint_id: ''});
      worker.saved += 1;
      callback(null, {supported: true, checkpoint_id: \`ckpt-\${run_id}-\${worker.saved}\`});
    },
    Terminate(call, callback) {
      worker.log.push('Terminate');
      worker.running.delete(call.request.run_id);
      callback(null, {});
    },
    StartRun(call, callback) {
      callback({code: ctx.grpc.status.UNIMPLEMENTED, details: 'not used here'});
    },
  });
  return {
    m: ctx.load('preempt'),
    worker,
    runs: ctx.load('/support/trainsched/runs.ts'),
    queue: ctx.load('/support/trainsched/queue.ts'),
    t0: ctx.clock.now(),
  };
}

async function running(runs, worker, runId: string, band: number, at: number): Promise<void> {
  await runs.put({run_id: runId, tenant: 't1', recipe_version: 'llama-ft-v3', dataset_version: 'ds-1', priority: 8 - 3 * band, band, state: 'running', enqueued_at_ms: at, worker: 'w-1', nodes: ['n1', 'n2'], checkpoint_id: 'ckpt-old'});
  worker.running.add(runId);
}

async function preempt(m, runId: string) {
  try {
    return await m.preempt(runId);
  } catch (e) {
    assert.fail(\`preempt(\${runId}) threw \${(e as Error).message}\`);
  }
}

export async function check_checkpoint_first(ctx) {
  const {m, worker, runs, t0} = setup(ctx);
  await running(runs, worker, 'run-a', 1, t0);
  assert.equal(await preempt(m, 'run-a'), true, 'a job that checkpointed must be preempted (true)');
  assert.deepEqual(worker.log, ['Checkpoint', 'Terminate'], \`the worker was called \${JSON.stringify(worker.log)}: ask for the checkpoint, wait for its id, then terminate\`);
  const run = await runs.get('run-a');
  assert.equal(run.checkpoint_id, 'ckpt-run-a-1', \`the run row holds checkpoint \${run.checkpoint_id}, the worker answered ckpt-run-a-1\`);
  assert.equal(ctx.grpc.callsTo('Terminate')[0].request.reason, 'preempted', 'the Terminate must carry reason preempted');
}

export async function check_grace_deadline(ctx) {
  const {m, worker, runs, t0} = setup(ctx);
  await running(runs, worker, 'run-a', 1, t0);
  ctx.grpc.setLatency('Checkpoint', 120); // the job hangs while it writes its checkpoint
  const before = ctx.clock.now();
  assert.equal(await preempt(m, 'run-a'), true, 'a job that ran out of grace must still be preempted (true)');
  const waited = (ctx.clock.now() - before) / 1000;
  const call = ctx.grpc.callsTo('Checkpoint')[0];
  assert(call.timeout !== null && call.timeout >= 29 && call.timeout <= 31, \`the Checkpoint call carried a deadline of \${call.timeout} s, expected GRACE_S = 30\`);
  assert(waited <= 31, \`preempt waited \${waited.toFixed(0)} s for a job that never finished its checkpoint: wait GRACE_S at most\`);
  const reasons = ctx.grpc.callsTo('Terminate').map(c => c.request.reason);
  assert.deepEqual(reasons, ['grace_deadline_exceeded'], \`the worker got Terminate with reasons \${JSON.stringify(reasons)}, expected one with grace_deadline_exceeded\`);
  assert.equal((await runs.get('run-a')).checkpoint_id, 'ckpt-old', 'the run resumes from the checkpoint it had (ckpt-old)');
  assert(ctx.redis.zscore('training:queue', 'run-a') !== null, 'a run preempted on the deadline path must be queued again');
}

export async function check_no_checkpoint_support(ctx) {
  const {m, worker, runs, t0} = setup(ctx);
  await running(runs, worker, 'run-a', 1, t0);
  worker.noCheckpoint.add('run-a');
  const result = await preempt(m, 'run-a');
  assert.equal(result, false, \`preempt returned \${result} for a job that cannot checkpoint, expected false\`);
  assert.equal(ctx.grpc.callsTo('Terminate').length, 0, 'a job that cannot checkpoint was terminated: its training since the start is lost. Leave it running');
  assert(worker.running.has('run-a'), 'the job is no longer running on the worker');
  assert.equal((await runs.get('run-a')).state, 'running', 'the run row must still read running');
  assert.equal(ctx.redis.zscore('training:queue', 'run-a'), null, 'a run that keeps running must not also be queued');
}

export async function check_requeue_preempted(ctx) {
  const {m, worker, runs, queue, t0} = setup(ctx);
  await running(runs, worker, 'run-a', 1, t0);
  await runs.put({run_id: 'run-b', tenant: 't1', recipe_version: 'llama-ft-v3', dataset_version: 'ds-1', priority: 5, band: 1, state: 'queued', enqueued_at_ms: t0 + 5000, worker: '', nodes: [], checkpoint_id: ''});
  await queue.enqueue('run-b', 1, t0 + 5000);
  assert.equal(await preempt(m, 'run-a'), true, 'a job that checkpointed must be preempted (true)');
  const score = ctx.redis.zscore('training:queue', 'run-a');
  const want = queue.positionScore(1, t0);
  assert.equal(Number(score), want, \`run-a waits with score \${score}, expected its own position \${want}: a preempted run must not vanish or lose its place\`);
  assert.equal((await runs.get('run-a')).state, 'queued', 'the preempted run must read queued');
  const head = await queue.claimNext('w-2', t0 + 6000);
  assert.equal(head, 'run-a', \`the next claim got \${head}: run-a was submitted before run-b and resumes first\`);
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

	pb "trainsched/gen/trainsched"
	"trainsched/queue"
	"trainsched/runs"

	"leetbuild/harness"
)

var preemptBg = context.Background()

// workerPeer is a worker agent: the jobs in running write a checkpoint when asked, except those in noCheckpoint.
type workerPeer struct {
	pb.UnimplementedWorkerServer
	running      map[string]bool
	noCheckpoint map[string]bool
	saved        int
}

func (w *workerPeer) Checkpoint(_ context.Context, req *pb.CheckpointRequest) (*pb.CheckpointReply, error) {
	if !w.running[req.GetRunId()] {
		return nil, status.Errorf(codes.NotFound, "run %s is not running: there is nothing left to checkpoint", req.GetRunId())
	}
	if w.noCheckpoint[req.GetRunId()] {
		return &pb.CheckpointReply{Supported: false}, nil
	}
	w.saved++
	return &pb.CheckpointReply{Supported: true, CheckpointId: fmt.Sprintf("ckpt-%s-%d", req.GetRunId(), w.saved)}, nil
}

func (w *workerPeer) Terminate(_ context.Context, req *pb.TerminateRequest) (*pb.TerminateReply, error) {
	delete(w.running, req.GetRunId())
	return &pb.TerminateReply{}, nil
}

func setup(ctx *harness.Ctx) *workerPeer {
	w := &workerPeer{running: map[string]bool{}, noCheckpoint: map[string]bool{}}
	pb.RegisterWorkerServer(ctx.GRPC.Server(""), w)
	return w
}

func runningRun(ctx *harness.Ctx, w *workerPeer, runID string, band int, at int64) {
	ctx.NoError(runs.Put(preemptBg, &runs.Run{RunID: runID, Tenant: "t1", RecipeVersion: "llama-ft-v3", DatasetVersion: "ds-1", Priority: 8 - 3*band, Band: band,
		State: "running", EnqueuedAtMs: at, Worker: "w-1", Nodes: []string{"n1", "n2"}, CheckpointID: "ckpt-old"}), "runs.Put")
	w.running[runID] = true
}

func mustPreempt(ctx *harness.Ctx, runID string) bool {
	ok, err := preempt(preemptBg, runID)
	ctx.NoError(err, "preempt(%s)", runID)
	return ok
}

func methodName(c harness.Call) string { return c.Method[strings.LastIndex(c.Method, "/")+1:] }

func workerMethods(ctx *harness.Ctx) []string {
	out := []string{}
	for _, c := range ctx.GRPC.Calls() {
		if name := methodName(c); name == "Checkpoint" || name == "Terminate" {
			out = append(out, name)
		}
	}
	return out
}

func terminateReasons(ctx *harness.Ctx) []string {
	out := []string{}
	for _, c := range ctx.GRPC.CallsTo("Terminate", "") {
		out = append(out, c.Request.(*pb.TerminateRequest).GetReason())
	}
	return out
}

func CheckCheckpointFirst(ctx *harness.Ctx) {
	w := setup(ctx)
	runningRun(ctx, w, "run-a", 1, ctx.Clock.Now())
	ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that checkpointed must be preempted")
	ctx.Equal(workerMethods(ctx), []string{"Checkpoint", "Terminate"}, "ask for the checkpoint, wait for its id, then terminate; the worker's calls")
	ctx.Equal(runs.Get(preemptBg, "run-a").CheckpointID, "ckpt-run-a-1", "the run row's checkpoint (the worker answered ckpt-run-a-1)")
	ctx.Equal(terminateReasons(ctx), []string{"preempted"}, "the Terminate reasons")
}

func CheckGraceDeadline(ctx *harness.Ctx) {
	w := setup(ctx)
	runningRun(ctx, w, "run-a", 1, ctx.Clock.Now())
	ctx.GRPC.SetLatency("Checkpoint", 120, "") // the job hangs while it writes its checkpoint
	before := ctx.Clock.Now()
	ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that ran out of grace must still be preempted")
	waited := float64(ctx.Clock.Now()-before) / 1000
	calls := ctx.GRPC.CallsTo("Checkpoint", "")
	ctx.Assert(len(calls) == 1 && calls[0].HasDeadline() && calls[0].Timeout >= 29*time.Second && calls[0].Timeout <= 31*time.Second, "the Checkpoint call must carry a deadline of GRACE_S = 30 s")
	ctx.Assert(waited <= 31, "preempt waited %.0f s for a job that never finished its checkpoint: wait GRACE_S at most", waited)
	ctx.Equal(terminateReasons(ctx), []string{"grace_deadline_exceeded"}, "the Terminate reasons")
	ctx.Equal(runs.Get(preemptBg, "run-a").CheckpointID, "ckpt-old", "the run resumes from the checkpoint it had; its checkpoint")
	_, queued := ctx.Redis.ZScore("training:queue", "run-a")
	ctx.Assert(queued, "a run preempted on the deadline path must be queued again")
}

func CheckNoCheckpointSupport(ctx *harness.Ctx) {
	w := setup(ctx)
	runningRun(ctx, w, "run-a", 1, ctx.Clock.Now())
	w.noCheckpoint["run-a"] = true
	ctx.Equal(mustPreempt(ctx, "run-a"), false, "preempt's result for a job that cannot checkpoint")
	ctx.Equal(len(ctx.GRPC.CallsTo("Terminate", "")), 0, "a job that cannot checkpoint must not be terminated (its training since the start would be lost); the Terminate calls")
	ctx.Assert(w.running["run-a"], "the job is no longer running on the worker")
	ctx.Equal(runs.Get(preemptBg, "run-a").State, "running", "the run row's state")
	_, queued := ctx.Redis.ZScore("training:queue", "run-a")
	ctx.Assert(!queued, "a run that keeps running must not also be queued")
}

func CheckRequeuePreempted(ctx *harness.Ctx) {
	w := setup(ctx)
	t0 := ctx.Clock.Now()
	runningRun(ctx, w, "run-a", 1, t0)
	ctx.NoError(runs.Put(preemptBg, &runs.Run{RunID: "run-b", Tenant: "t1", RecipeVersion: "llama-ft-v3", DatasetVersion: "ds-1", Priority: 5, Band: 1, State: "queued", EnqueuedAtMs: t0 + 5000}), "runs.Put")
	ctx.NoError(queue.Enqueue(preemptBg, "run-b", 1, t0+5000), "queue.Enqueue")
	ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that checkpointed must be preempted")
	score, queued := ctx.Redis.ZScore("training:queue", "run-a")
	ctx.Assert(queued && int64(score) == queue.PositionScore(1, t0), "run-a waits with score %.0f (queued %t), expected its own position %d: a preempted run must not vanish or lose its place", score, queued, queue.PositionScore(1, t0))
	ctx.Equal(runs.Get(preemptBg, "run-a").State, "queued", "the preempted run's state")
	head, err := queue.ClaimNext(preemptBg, "w-2", t0+6000)
	ctx.NoError(err, "queue.ClaimNext")
	ctx.Equal(head, "run-a", "run-a was submitted before run-b and resumes first; the next claim")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <set>
#include <string>
#include <vector>

namespace {

// A worker agent: the jobs in running write a checkpoint when asked, except those in no_checkpoint.
class WorkerPeer final : public trainsched::Worker::Service {
 public:
  std::set<std::string> running;
  std::set<std::string> no_checkpoint;
  int saved = 0;

  grpc::Status Checkpoint(grpc::ServerContext*, const trainsched::CheckpointRequest* req, trainsched::CheckpointReply* out) override {
    if (!running.count(req->run_id())) {
      return grpc::Status(grpc::StatusCode::NOT_FOUND, "run " + req->run_id() + " is not running: there is nothing left to checkpoint");
    }
    if (no_checkpoint.count(req->run_id())) {
      out->set_supported(false);
      return grpc::Status::OK;
    }
    saved++;
    out->set_supported(true);
    out->set_checkpoint_id("ckpt-" + req->run_id() + "-" + std::to_string(saved));
    return grpc::Status::OK;
  }

  grpc::Status Terminate(grpc::ServerContext*, const trainsched::TerminateRequest* req, trainsched::TerminateReply*) override {
    running.erase(req->run_id());
    return grpc::Status::OK;
  }
};

WorkerPeer& setup(harness::Ctx& ctx) {
  static WorkerPeer* peer = nullptr;
  delete peer;
  peer = new WorkerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

void runningRun(WorkerPeer& w, const std::string& run_id, int band, long long at) {
  runs::Run run;
  run.run_id = run_id;
  run.tenant = "t1";
  run.recipe_version = "llama-ft-v3";
  run.dataset_version = "ds-1";
  run.priority = 8 - 3 * band;
  run.band = band;
  run.state = "running";
  run.enqueued_at_ms = at;
  run.worker = "w-1";
  run.nodes = {"n1", "n2"};
  run.checkpoint_id = "ckpt-old";
  runs::put(run);
  w.running.insert(run_id);
}

bool mustPreempt(harness::Ctx& ctx, const std::string& run_id) {
  try {
    return preempt(run_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("preempt(%s) threw %s: %s", run_id, harness::CurrentExceptionType(), e.what());
  }
  return false;
}

std::string methodName(const harness::Call& c) { return c.Method.substr(c.Method.rfind('/') + 1); }

std::vector<std::string> workerMethods(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& c : ctx.GRPC.Calls()) {
    const std::string name = methodName(c);
    if (name == "Checkpoint" || name == "Terminate") out.push_back(name);
  }
  return out;
}

std::vector<std::string> terminateReasons(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& c : ctx.GRPC.CallsTo("Terminate")) out.push_back(c.Request<trainsched::TerminateRequest>().reason());
  return out;
}

}  // namespace

void CheckCheckpointFirst(harness::Ctx& ctx) {
  auto& w = setup(ctx);
  runningRun(w, "run-a", 1, ctx.Clock.Now());
  ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that checkpointed must be preempted");
  ctx.Equal(workerMethods(ctx), {"Checkpoint", "Terminate"}, "ask for the checkpoint, wait for its id, then terminate; the worker's calls");
  ctx.Equal(runs::get("run-a")->checkpoint_id, "ckpt-run-a-1", "the run row's checkpoint (the worker answered ckpt-run-a-1)");
  ctx.Equal(terminateReasons(ctx), {"preempted"}, "the Terminate reasons");
}

void CheckGraceDeadline(harness::Ctx& ctx) {
  auto& w = setup(ctx);
  runningRun(w, "run-a", 1, ctx.Clock.Now());
  ctx.GRPC.SetLatency("Checkpoint", 120);  // the job hangs while it writes its checkpoint
  const long long before = ctx.Clock.Now();
  ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that ran out of grace must still be preempted");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  const auto calls = ctx.GRPC.CallsTo("Checkpoint");
  ctx.Assert(calls.size() == 1 && calls[0].HasDeadline() && calls[0].TimeoutSeconds() >= 29 && calls[0].TimeoutSeconds() <= 31,
             "the Checkpoint call must carry a deadline of GRACE_S = 30 s");
  ctx.Assert(waited <= 31, "preempt waited %.0f s for a job that never finished its checkpoint: wait GRACE_S at most", waited);
  ctx.Equal(terminateReasons(ctx), {"grace_deadline_exceeded"}, "the Terminate reasons");
  ctx.Equal(runs::get("run-a")->checkpoint_id, "ckpt-old", "the run resumes from the checkpoint it had; its checkpoint");
  ctx.Assert(ctx.Redis.ZScore("training:queue", "run-a").has_value(), "a run preempted on the deadline path must be queued again");
}

void CheckNoCheckpointSupport(harness::Ctx& ctx) {
  auto& w = setup(ctx);
  runningRun(w, "run-a", 1, ctx.Clock.Now());
  w.no_checkpoint.insert("run-a");
  ctx.Equal(mustPreempt(ctx, "run-a"), false, "preempt's result for a job that cannot checkpoint");
  ctx.Equal(ctx.GRPC.CallsTo("Terminate").size(), 0, "a job that cannot checkpoint must not be terminated (its training since the start would be lost); the Terminate calls");
  ctx.Assert(w.running.count("run-a") == 1, "the job is no longer running on the worker");
  ctx.Equal(runs::get("run-a")->state, "running", "the run row's state");
  ctx.Assert(!ctx.Redis.ZScore("training:queue", "run-a").has_value(), "a run that keeps running must not also be queued");
}

void CheckRequeuePreempted(harness::Ctx& ctx) {
  auto& w = setup(ctx);
  const long long t0 = ctx.Clock.Now();
  runningRun(w, "run-a", 1, t0);
  runs::Run b;
  b.run_id = "run-b";
  b.tenant = "t1";
  b.recipe_version = "llama-ft-v3";
  b.dataset_version = "ds-1";
  b.priority = 5;
  b.band = 1;
  b.state = "queued";
  b.enqueued_at_ms = t0 + 5000;
  runs::put(b);
  queue::enqueue("run-b", 1, t0 + 5000);
  ctx.Equal(mustPreempt(ctx, "run-a"), true, "a job that checkpointed must be preempted");
  const auto score = ctx.Redis.ZScore("training:queue", "run-a");
  ctx.Assert(score && static_cast<long long>(*score) == queue::positionScore(1, t0),
             "run-a waits with score %.0f, expected its own position %d: a preempted run must not vanish or lose its place", score.value_or(-1), queue::positionScore(1, t0));
  ctx.Equal(runs::get("run-a")->state, "queued", "the preempted run's state");
  ctx.Equal(queue::claimNext("w-2", t0 + 6000).value_or(""), "run-a", "run-a was submitted before run-b and resumes first; the next claim");
}
`,
  },
  hints: [
    'After every preemption the run restarts from its first step, a hanging job stalls the scheduler for minutes, and runs on old workers without checkpoint support die and never come back.',
    'The starter sends `Terminate` before `Checkpoint`, so the process is gone when the checkpoint is asked for; the call has no deadline, `supported` is never read, and nothing calls `queue.enqueue`.',
    'Call `Checkpoint` with `timeout=GRACE_S`; on `DEADLINE_EXCEEDED` terminate with `grace_deadline_exceeded`; on `not reply.supported` return False; else `set_checkpoint`, `Terminate(reason="preempted")`; then `queue.enqueue(run_id, run["band"], run["enqueued_at_ms"])`.',
  ],
  debrief: `The order of the two calls is the whole contract: a checkpoint can only be taken from a process that still exists, and a terminate can only be safe once its id is recorded. The grace deadline bounds what the job may cost the scheduler, the way Slurm's \`GraceTime\` does, and the deadline path still terminates, since the GPUs were promised to someone else; the run loses only the minutes since its last checkpoint. A job that says it cannot checkpoint is left alone because killing it would lose more than the waiting work gains. Requeueing at the run's own position keeps the preemption from becoming a punishment. Production schedulers cap how often one run may be preempted, and prefer victims whose last checkpoint is recent.`,
};
