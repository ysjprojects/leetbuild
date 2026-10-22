import type {Step} from '@/lib/types';

export const trainingDependencyStep: Step = {
  id: 'dependency',
  title: 'Preemption calls that checkpoint before they kill',
  concept: 'grpc',
  file: 'client',
  focus: ['scheduler', 'worker', 'cluster', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the preemption path: it
terminates the process and marks the run failed. It compiles, it frees the fleet, and it hides the
flaw that costs the most GPU hours — it kills before it asks for a checkpoint. Review it like the
person who owns the training budget, fix it, and prove the fix with the checks below.

Implement the scheduler's preemption path: when higher-priority work arrives, the running job is
asked to preempt over gRPC **before** anything is terminated.

- The call is a gRPC \`Preempt(run_id)\` on the worker with a **grace deadline** of
  \`GRACE_DEADLINE_S = 30\` seconds, enforced on the request and on the call itself. The draft never
  calls the worker: it terminates the process out of the scheduler, so the job cannot save anything.
- The worker writes a checkpoint and replies with a **checkpoint id**. The process is terminated
  **only after** that id is received (\`preempting\` → \`checkpointed\` → \`preempted\`). The draft
  kills first and reports \`failed\`, so the last hours of training are gone with no checkpoint to
  resume from.
- If no checkpoint id arrives before the grace deadline, the scheduler still terminates — but on the
  **deadline path**, recording \`reason: grace_deadline_exceeded\`, so the loss is reported instead
  of silent.
- A worker that replies \`checkpoint_supported = false\` must **not** be preempted: the scheduler
  leaves the job running and puts the waiting run **behind it** (back in the queue at its own band)
  instead of retrying the call. Retrying a preempt against a worker that cannot checkpoint is how one
  preemption turns into a kill.
- The run's history must not contain a \`failed\` transition caused by preemption: preemption ends in
  \`preempted\`, carrying the checkpoint id when there is one.

**Failure mode the checks target.** The draft looks right because the demo preempts a job that has
nothing worth saving. On a real fleet the order of the two calls is the whole product: terminate
before the checkpoint id and every preemption throws away the training progress the checkpoint
existed to keep. The second flaw is quieter — a worker that answers "no checkpoint support" is not an
error to retry, it is a job that must be allowed to finish, and the new work waits behind it.
Treating that answer as a retryable failure turns a scheduling decision into data loss.`,
  sequence: {
    participants: ['Training Scheduler', 'Training worker', 'Redis queue', 'Cluster API'],
    messages: [
      {
        from: 'Training Scheduler',
        to: 'Training worker',
        label: 'Preempt(run_id) · grace deadline 30 s',
        kind: 'sync',
      },
      {from: 'Training worker', to: 'Training Scheduler', label: 'checkpoint id · checkpoint_supported', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'Training worker',
        label: 'Terminate(run_id, checkpoint_id) — only after the id',
        kind: 'sync',
      },
      {from: 'Training worker', to: 'Training Scheduler', label: 'process stopped · checkpoint kept', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'Redis queue',
        label: 'requeue the preempted run at its own band',
        kind: 'async',
      },
      {from: 'Training Scheduler', to: 'Cluster API', label: 'release the nodes for the waiting run', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'preempt-call',
      title: 'Asks the worker to preempt under a grace deadline',
      detail:
        'The scheduler calls the worker’s gRPC `Preempt` with `GRACE_DEADLINE_S` = 30 and a deadline on the call. The draft terminates the process from the scheduler and never asks the worker.',
      match: {
        python: {all: [/GRACE_DEADLINE_S\s*=\s*30/, /\.preempt\(/, /timeout=/]},
        typescript: {all: [/GRACE_DEADLINE_S\s*=\s*30/, /\.preempt\(/, /deadline/]},
        go: {all: [/graceDeadlineS\s*=\s*30/, /\.Preempt\(/, /context\.WithTimeout/]},
        scala: {all: [/GraceDeadlineS\s*=\s*30/, /\.preempt\(/, /deadline/]},
        cpp: {all: [/kGraceDeadlineS\s*=\s*30/, /->Preempt\(/, /set_deadline\(/]},
      },
    },
    {
      id: 'checkpoint-first',
      title: 'Terminates only after a checkpoint id is received',
      detail:
        'The checkpoint id from the worker is captured first and the process is stopped only afterwards, so the run can resume from that checkpoint. The draft kills immediately and marks the run `failed`.',
      match: {
        python: {all: [/checkpoint_id/, /worker\.terminate\(/], order: [/checkpoint_id = /, /worker\.terminate\(/]},
        typescript: {all: [/checkpointId/, /worker\.terminate\(/], order: [/checkpointId = /, /worker\.terminate\(/]},
        go: {all: [/CheckpointID/, /worker\.Terminate\(/], order: [/checkpointID := /, /worker\.Terminate\(/]},
        scala: {all: [/checkpointId/, /worker\.terminate\(/], order: [/val checkpointId = /, /worker\.terminate\(/]},
        cpp: {all: [/checkpoint_id/, /worker->terminate\(/], order: [/checkpoint_id = /, /worker->terminate\(/]},
      },
    },
    {
      id: 'grace-deadline',
      title: 'A checkpoint that never arrives ends on the deadline path',
      detail:
        'When the grace deadline expires with no checkpoint id the scheduler still stops the job, but records `grace_deadline_exceeded` as the reason instead of losing the run silently. The draft has no deadline and no reason.',
      match: {
        python: {
          all: [/GRACE_DEADLINE_S/, /grace_deadline_exceeded/, /worker\.terminate\(/],
          order: [/grace_deadline_exceeded/, /worker\.terminate\(/],
        },
        typescript: {
          all: [/GRACE_DEADLINE_S/, /grace_deadline_exceeded/, /worker\.terminate\(/],
          order: [/grace_deadline_exceeded/, /worker\.terminate\(/],
        },
        go: {
          all: [/graceDeadlineS/, /grace_deadline_exceeded/, /worker\.Terminate\(/],
          order: [/grace_deadline_exceeded/, /worker\.Terminate\(/],
        },
        scala: {
          all: [/GraceDeadlineS/, /grace_deadline_exceeded/, /worker\.terminate\(/],
          order: [/grace_deadline_exceeded/, /worker\.terminate\(/],
        },
        cpp: {
          all: [/kGraceDeadlineS/, /grace_deadline_exceeded/, /worker->terminate\(/],
          order: [/grace_deadline_exceeded/, /worker->terminate\(/],
        },
      },
    },
    {
      id: 'no-checkpoint-support',
      title: 'A worker without checkpoint support keeps running',
      detail:
        'A reply with `checkpoint_supported` false sends the waiting run back to the queue behind the job instead of terminating it. The draft retries the preempt against a worker that cannot checkpoint, which is what turns one preemption into a kill.',
      match: {
        python: {
          all: [/checkpoint_supported/, /NO_CHECKPOINT_REASON/, /queue\.enqueue\(/],
          order: [/checkpoint_supported/, /queue\.enqueue\(/],
        },
        typescript: {
          all: [/checkpoint_supported/, /NO_CHECKPOINT_REASON/, /queue\.enqueue\(/],
          order: [/checkpoint_supported/, /queue\.enqueue\(/],
        },
        go: {
          all: [/CheckpointSupported/, /noCheckpointReason/, /queue\.enqueue\(/],
          order: [/CheckpointSupported/, /queue\.enqueue\(/],
        },
        scala: {
          all: [/checkpoint_supported/, /NoCheckpointReason/, /queue\.enqueue\(/],
          order: [/checkpoint_supported/, /queue\.enqueue\(/],
        },
        cpp: {
          all: [/checkpoint_supported/, /kNoCheckpointReason/, /->enqueue\(/],
          order: [/checkpoint_supported/, /->enqueue\(/],
        },
      },
    },
    {
      id: 'no-immediate-kill',
      title: 'Preemption never reports the run as failed',
      detail:
        'The preemption path moves the run to `preempted` (with the checkpoint id when there is one) and never writes a `failed` state for it. The draft’s kill-and-fail transition is what the check rejects.',
      match: {
        python: {all: [/runs\.update_state\(/, /"preempted"/], none: [/update_state\([^)]*"failed"/]},
        typescript: {all: [/runs\.updateState\(/, /'preempted'/], none: [/updateState\([^)]*'failed'/]},
        go: {all: [/runs\.UpdateState\(/, /"preempted"/], none: [/UpdateState\([^)]*"failed"/]},
        scala: {all: [/runs\.updateState\(/, /"preempted"/], none: [/updateState\([^)]*"failed"/]},
        cpp: {all: [/runs->updateState\(/, /"preempted"/], none: [/updateState\([^)]*"failed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Preempt a running job: a model-generated draft that kills first and asks questions later."""
import logging

logger = logging.getLogger("trainsched")


class WorkerClient:
    def terminate(self, run_id: str, reason: str) -> None:
        """Stop the process."""
        raise NotImplementedError


class RunStore:
    def update_state(self, run_id: str, state: str, reason: str | None = None) -> None:
        """Move the run to a new state."""
        raise NotImplementedError


worker = WorkerClient()
runs = RunStore()


def preempt(run_id: str, pending_run: dict) -> str:
    # TODO: this draft terminates the process immediately and marks the run failed, so a job that
    # could have checkpointed loses hours of training; it also never asks the worker whether it can
    # checkpoint at all. Review both before preemption ships.
    worker.terminate(run_id, "preempted by higher priority")
    runs.update_state(run_id, "failed", reason="preempted")
    logger.info("preempted run_id=%s state=failed", run_id)
    return "failed"
`,
      solution: `"""Preempt a running job over gRPC: the checkpoint id first, the kill second."""
import logging

import grpc

logger = logging.getLogger("trainsched")

GRACE_DEADLINE_S = 30
TERMINATE_REASON = "preempted_by_higher_priority"
NO_CHECKPOINT_REASON = "no_checkpoint_support"


class WorkerClient:
    def preempt(self, run_id: str, grace_deadline_s: int, timeout: float):
        """Ask the worker to checkpoint and reply with the checkpoint id."""
        raise NotImplementedError

    def terminate(self, run_id: str, checkpoint_id: str, reason: str) -> None:
        """Stop the process, keeping the checkpoint it just wrote."""
        raise NotImplementedError


class RunStore:
    def update_state(self, run_id: str, state: str, reason: str | None = None) -> None:
        """Move the run to a new state; a preemption never writes 'failed'."""
        raise NotImplementedError


class RunQueue:
    def enqueue(self, run: dict) -> None:
        """Put a waiting run back in the queue at its own band."""
        raise NotImplementedError


worker = WorkerClient()
runs = RunStore()
queue = RunQueue()


def preempt(run_id: str, pending_run: dict) -> str:
    """Preempt one run for higher-priority work: checkpoint id first, kill second."""
    try:
        reply = worker.preempt(run_id, GRACE_DEADLINE_S, timeout=GRACE_DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
            raise
        reply = None

    if reply is not None and not reply.checkpoint_supported:
        # Nothing to save: leave the job running and let the waiting run go behind it.
        queue.enqueue(pending_run)
        logger.info("preempt skipped run_id=%s reason=%s", run_id, NO_CHECKPOINT_REASON)
        return "queued_behind"

    checkpoint_id = reply.checkpoint_id if reply is not None else ""
    if not checkpoint_id:
        # The grace deadline expired with no checkpoint: stop the job, and say why.
        runs.update_state(run_id, "preempted", reason="grace_deadline_exceeded")
        worker.terminate(run_id, "", "grace_deadline_exceeded")
        return "preempted"

    runs.update_state(run_id, "checkpointed", reason=None)
    worker.terminate(run_id, checkpoint_id, TERMINATE_REASON)
    runs.update_state(run_id, "preempted", reason=TERMINATE_REASON)
    logger.info("preempted run_id=%s checkpoint_id=%s", run_id, checkpoint_id)
    return "preempted"
`,
    },
    typescript: {
      starter: `/** Preempt a running job: a model-generated draft that kills first and asks questions later. */
const log = {info: (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields))};

class WorkerClient {
  terminate(runId: string, reason: string): void {
    throw new Error('provided by the platform');
  }
}

class RunStore {
  updateState(runId: string, state: string, reason?: string): void {
    throw new Error('provided by the platform');
  }
}

const worker = new WorkerClient();
const runs = new RunStore();

export async function preempt(runId: string, pendingRun: {run_id: string; band: number}): Promise<string> {
  // TODO: this draft terminates the process immediately and marks the run failed, so a job that
  // could have checkpointed loses hours of training; it also never asks the worker whether it can
  // checkpoint at all. Review both before preemption ships.
  worker.terminate(runId, 'preempted by higher priority');
  runs.updateState(runId, 'failed', 'preempted');
  log.info({run_id: runId, state: 'failed'});
  return 'failed';
}
`,
      solution: `/** Preempt a running job over gRPC: the checkpoint id first, the kill second. */
import {status, ServiceError} from '@grpc/grpc-js';

const log = {info: (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields))};

export const GRACE_DEADLINE_S = 30;
export const TERMINATE_REASON = 'preempted_by_higher_priority';
export const NO_CHECKPOINT_REASON = 'no_checkpoint_support';

export interface PreemptReply {
  checkpoint_supported: boolean;
  checkpoint_id: string;
}

export interface PendingRun {
  run_id: string;
  band: number;
}

class WorkerClient {
  preempt(runId: string, graceDeadlineS: number, deadline: number): Promise<PreemptReply> {
    throw new Error('provided by the platform');
  }

  terminate(runId: string, checkpointId: string, reason: string): void {
    throw new Error('provided by the platform');
  }
}

class RunStore {
  updateState(runId: string, state: string, reason?: string): void {
    throw new Error('provided by the platform');
  }
}

class RunQueue {
  enqueue(run: PendingRun): void {
    throw new Error('provided by the platform');
  }
}

const worker = new WorkerClient();
const runs = new RunStore();
const queue = new RunQueue();

export async function preempt(runId: string, pendingRun: PendingRun): Promise<string> {
  let reply: PreemptReply | null = null;
  try {
    reply = await worker.preempt(runId, GRACE_DEADLINE_S, Date.now() + GRACE_DEADLINE_S * 1000);
  } catch (error) {
    if ((error as ServiceError).code !== status.DEADLINE_EXCEEDED) throw error;
  }

  if (reply !== null && !reply.checkpoint_supported) {
    // Nothing to save: leave the job running and let the waiting run go behind it.
    queue.enqueue(pendingRun);
    log.info({run_id: runId, reason: NO_CHECKPOINT_REASON});
    return 'queued_behind';
  }

  const checkpointId = reply === null ? '' : reply.checkpoint_id;
  if (checkpointId === '') {
    // The grace deadline expired with no checkpoint: stop the job, and say why.
    runs.updateState(runId, 'preempted', 'grace_deadline_exceeded');
    worker.terminate(runId, '', 'grace_deadline_exceeded');
    return 'preempted';
  }

  runs.updateState(runId, 'checkpointed');
  worker.terminate(runId, checkpointId, TERMINATE_REASON);
  runs.updateState(runId, 'preempted', TERMINATE_REASON);
  log.info({run_id: runId, checkpoint_id: checkpointId});
  return 'preempted';
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"log"
)

type WorkerClient struct{}

func (c *WorkerClient) Terminate(ctx context.Context, runID, reason string) error {
	return nil
}

type RunStore struct{}

func (s *RunStore) UpdateState(ctx context.Context, runID, state, reason string) error {
	return nil
}

type PendingRun struct {
	RunID string
	Band  int
}

var (
	worker = &WorkerClient{}
	runs   = &RunStore{}
)

// Preempt frees a run's nodes for higher-priority work.
func Preempt(ctx context.Context, runID string, pendingRun PendingRun) (string, error) {
	// TODO: this draft terminates the process immediately and marks the run failed, so a job that
	// could have checkpointed loses hours of training; it also never asks the worker whether it can
	// checkpoint at all. Review both before preemption ships.
	if err := worker.Terminate(ctx, runID, "preempted by higher priority"); err != nil {
		return "", err
	}
	if err := runs.UpdateState(ctx, runID, "failed", "preempted"); err != nil {
		return "", err
	}
	log.Printf("preempted run_id=%s state=failed", runID)
	return "failed", nil
}
`,
      solution: `package client

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	graceDeadlineS     = 30
	terminateReason    = "preempted_by_higher_priority"
	noCheckpointReason = "no_checkpoint_support"
)

type PreemptReply struct {
	CheckpointSupported bool
	CheckpointID        string
}

type PendingRun struct {
	RunID string
	Band  int
}

// WorkerClient, RunStore and RunQueue are the platform's; this step only calls them.
type WorkerClient struct{}

func (c *WorkerClient) Preempt(ctx context.Context, runID string) (*PreemptReply, error) {
	return nil, nil
}

func (c *WorkerClient) Terminate(ctx context.Context, runID, checkpointID, reason string) error {
	return nil
}

type RunStore struct{}

func (s *RunStore) UpdateState(ctx context.Context, runID, state, reason string) error {
	return nil
}

type RunQueue struct{}

func (q *RunQueue) enqueue(ctx context.Context, run PendingRun) error {
	return nil
}

var (
	worker = &WorkerClient{}
	runs   = &RunStore{}
	queue  = &RunQueue{}
)

// Preempt asks a running job to checkpoint before its nodes are reclaimed.
func Preempt(ctx context.Context, runID string, pendingRun PendingRun) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, graceDeadlineS*time.Second)
	defer cancel()

	reply, err := worker.Preempt(callCtx, runID)
	if err != nil {
		if status.Code(err) != codes.DeadlineExceeded {
			return "", err
		}
		reply = nil
	}

	if reply != nil && !reply.CheckpointSupported {
		// Nothing to save: leave the job running and let the waiting run go behind it.
		if err := queue.enqueue(ctx, pendingRun); err != nil {
			return "", err
		}
		log.Printf("preempt skipped run_id=%s reason=%s", runID, noCheckpointReason)
		return "queued_behind", nil
	}

	checkpointID := ""
	if reply != nil {
		checkpointID = reply.CheckpointID
	}
	if checkpointID == "" {
		// The grace deadline expired with no checkpoint: stop the job, and say why.
		if err := runs.UpdateState(ctx, runID, "preempted", "grace_deadline_exceeded"); err != nil {
			return "", err
		}
		if err := worker.Terminate(ctx, runID, "", "grace_deadline_exceeded"); err != nil {
			return "", err
		}
		return "preempted", nil
	}

	if err := runs.UpdateState(ctx, runID, "checkpointed", ""); err != nil {
		return "", err
	}
	if err := worker.Terminate(ctx, runID, checkpointID, terminateReason); err != nil {
		return "", err
	}
	if err := runs.UpdateState(ctx, runID, "preempted", terminateReason); err != nil {
		return "", err
	}
	log.Printf("preempted run_id=%s checkpoint_id=%s", runID, checkpointID)
	return "preempted", nil
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object PreemptClient {
  final case class PendingRun(run_id: String, band: Int)

  class WorkerClient {
    def terminate(runId: String, reason: String): Unit = ???
  }

  class RunStore {
    def updateState(runId: String, state: String, reason: Option[String]): Unit = ???
  }

  val worker = new WorkerClient
  val runs = new RunStore

  // TODO: this draft terminates the process immediately and marks the run failed, so a job that
  // could have checkpointed loses hours of training; it also never asks the worker whether it can
  // checkpoint at all. Review both before preemption ships.
  def preempt(runId: String, pendingRun: PendingRun): String = {
    worker.terminate(runId, "preempted by higher priority")
    runs.updateState(runId, "failed", Some("preempted"))
    println(s"preempted run_id=$runId state=failed")
    "failed"
  }
}
`,
      solution: `import io.grpc.{Status, StatusRuntimeException}

object PreemptClient {
  val GraceDeadlineS = 30
  val TerminateReason = "preempted_by_higher_priority"
  val NoCheckpointReason = "no_checkpoint_support"

  final case class PreemptReply(checkpoint_supported: Boolean, checkpoint_id: String)
  final case class PendingRun(run_id: String, band: Int)

  // WorkerClient, RunStore and RunQueue are the platform's; this step only calls them.
  class WorkerClient {
    def preempt(runId: String, graceDeadlineS: Int, deadlineMs: Long): PreemptReply = ???
    def terminate(runId: String, checkpointId: String, reason: String): Unit = ???
  }

  class RunStore {
    def updateState(runId: String, state: String, reason: Option[String]): Unit = ???
  }

  class RunQueue {
    def enqueue(run: PendingRun): Unit = ???
  }

  val worker = new WorkerClient
  val runs = new RunStore
  val queue = new RunQueue

  def preempt(runId: String, pendingRun: PendingRun): String = {
    val reply =
      try worker.preempt(runId, GraceDeadlineS, System.currentTimeMillis() + GraceDeadlineS * 1000L)
      catch {
        case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED => null
      }

    if (reply != null && !reply.checkpoint_supported) {
      // Nothing to save: leave the job running and let the waiting run go behind it.
      queue.enqueue(pendingRun)
      println(s"preempt skipped run_id=$runId reason=$NoCheckpointReason")
      "queued_behind"
    } else {
      val checkpointId = if (reply == null) "" else reply.checkpoint_id
      if (checkpointId.isEmpty) {
        // The grace deadline expired with no checkpoint: stop the job, and say why.
        runs.updateState(runId, "preempted", Some("grace_deadline_exceeded"))
        worker.terminate(runId, "", "grace_deadline_exceeded")
        "preempted"
      } else {
        runs.updateState(runId, "checkpointed", None)
        worker.terminate(runId, checkpointId, TerminateReason)
        runs.updateState(runId, "preempted", Some(TerminateReason))
        "preempted"
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <string>

// WorkerClient and RunStore are the platform's; this step only calls them.
class WorkerClient {
 public:
  void terminate(const std::string& run_id, const std::string& reason) {}
};

class RunStore {
 public:
  void updateState(const std::string& run_id, const std::string& state, const std::string& reason) {}
};

struct PendingRun {
  std::string run_id;
  int band;
};

// TODO: this draft terminates the process immediately and marks the run failed, so a job that could
// have checkpointed loses hours of training; it also never asks the worker whether it can checkpoint
// at all. Review both before preemption ships.
std::string preempt(WorkerClient* worker, RunStore* runs, const std::string& run_id, const PendingRun& pending_run) {
  worker->terminate(run_id, "preempted by higher priority");
  runs->updateState(run_id, "failed", "preempted");
  return "failed";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

constexpr int kGraceDeadlineS = 30;
const std::string kTerminateReason = "preempted_by_higher_priority";
const std::string kNoCheckpointReason = "no_checkpoint_support";

struct PreemptReply {
  bool checkpoint_supported = false;
  std::string checkpoint_id;
};

struct PendingRun {
  std::string run_id;
  int band = 0;
};

// WorkerClient, RunStore and RunQueue are the platform's; this step only calls them.
class WorkerClient {
 public:
  grpc::Status Preempt(grpc::ClientContext* ctx, const std::string& run_id, std::optional<PreemptReply>* reply) {
    return grpc::Status::OK;
  }

  void terminate(const std::string& run_id, const std::string& checkpoint_id, const std::string& reason) {}
};

class RunStore {
 public:
  void updateState(const std::string& run_id, const std::string& state, const std::string& reason) {}
};

class RunQueue {
 public:
  void enqueue(const PendingRun& run) {}
};

std::string preempt(WorkerClient* worker, RunStore* runs, RunQueue* queue, const std::string& run_id,
                    const PendingRun& pending_run) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kGraceDeadlineS));
  std::optional<PreemptReply> reply;
  const grpc::Status call = worker->Preempt(&ctx, run_id, &reply);
  if (!call.ok() && call.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
    throw std::runtime_error(call.error_message());
  }
  if (!call.ok()) reply = std::nullopt;

  if (reply.has_value() && !reply->checkpoint_supported) {
    // Nothing to save: leave the job running and let the waiting run go behind it.
    queue->enqueue(pending_run);
    std::cerr << "preempt skipped run_id=" << run_id << " reason=" << kNoCheckpointReason << "\\n";
    return "queued_behind";
  }

  const std::string checkpoint_id = reply.has_value() ? reply->checkpoint_id : std::string();
  if (checkpoint_id.empty()) {
    // The grace deadline expired with no checkpoint: stop the job, and say why.
    runs->updateState(run_id, "preempted", "grace_deadline_exceeded");
    worker->terminate(run_id, "", "grace_deadline_exceeded");
    return "preempted";
  }

  runs->updateState(run_id, "checkpointed", "");
  worker->terminate(run_id, checkpoint_id, kTerminateReason);
  runs->updateState(run_id, "preempted", kTerminateReason);
  std::cerr << "preempted run_id=" << run_id << " checkpoint_id=" << checkpoint_id << "\\n";
  return "preempted";
}
`,
    },
  },
  hints: [
    'Send the call and wait for its answer before you touch the process: `Preempt(run_id)` with `GRACE_DEADLINE_S` as both the request’s grace and the gRPC deadline. The reply — `checkpoint_id` plus `checkpoint_supported` — is the contract, and the deadline is what keeps a wedged worker from pinning the scheduler.',
    'The kill is the *second* step, never the first: capture `checkpoint_id`, move the run to `checkpointed`, then terminate with that id. If the deadline passes with no checkpoint, terminate anyway — but on that path, with `grace_deadline_exceeded` as the reason, so the loss is visible.',
    '`checkpoint_supported = false` is not an error to retry: it means the job has nothing to save, so leave it running and put the waiting run back in the queue behind it. Retrying the preempt is how a scheduling decision turns into an uncheckpointed kill.',
  ],
  debrief: `The interviewer is testing whether you can review the two-call shape that makes preemption safe. The
draft looks right because the demo preempts a job with nothing to lose: the kill frees the nodes, the
failed state shows up on a dashboard, and nobody notices there was never a checkpoint. The order of
the calls is the flaw worth naming — a checkpoint id that arrives after the process is gone is worth
nothing — and the grace deadline is what makes the wait bounded instead of an indefinite stall. The
second flaw is subtler: a worker that reports no checkpoint support is a job to leave alone, and the
waiting run queues behind it. Real schedulers add a resumable-run lookup on startup, a checkpoint
retention policy so old ids are pruned, and a distinction between a preemption and a failure in every
dashboard and alert that watches the fleet.`,
};
