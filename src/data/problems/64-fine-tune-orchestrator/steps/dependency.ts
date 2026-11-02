import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Training calls with checkpointed progress and honest failure',
  concept: 'grpc',
  file: 'client',
  focus: ['trainer', 'checkpoints'],
  task: `## Task

**Starting point.** The starter is the gRPC trainer client: \`watch\` loops forever, sends a
\`Heartbeat\` under a 30-second timeout and calls \`restart_job\` the moment one is missed, with no
checkpoint and no failure path. It drives the happy path and hides five flaws.

**Failure mode the checks target.** Restarting a silent trainer from scratch throws away every hour
already paid for, and because the job looks \`running\` again nobody can tell. Without the checkpoint
id a restart resumed from, a result cannot be reproduced a week later. And a trainer whose heartbeat
is broken becomes an infinite restart loop that burns budget without surfacing a failure.

- **Heartbeat deadline.** Every \`Heartbeat\` runs under a **60-second** deadline; a trainer that
  does not answer within it has missed a heartbeat.
- **Checkpoint before restart.** A missed heartbeat is not proof of a crash. Call
  \`RequestCheckpoint\` first; only when a checkpoint id comes back may the job restart, and the
  restart names the checkpoint it resumed from.
- **Explicit failure.** A trainer that cannot checkpoint is failed with a reason, not restarted
  blind.
- **Stop on repeated failure.** After **3** heartbeat failures the job is failed and the loop stops.
- Record on the job whether a restart reused a checkpoint, so the lineage is accurate.`,
  sequence: {
    participants: ['Orchestrator', 'Trainer', 'Checkpoint store'],
    messages: [
      {from: 'Orchestrator', to: 'Trainer', label: 'Heartbeat(job_id) · deadline 60s', kind: 'sync'},
      {from: 'Trainer', to: 'Orchestrator', label: 'heartbeat ok / silence', kind: 'reply'},
      {from: 'Orchestrator', to: 'Trainer', label: 'RequestCheckpoint(job_id) — before any restart', kind: 'sync'},
      {from: 'Trainer', to: 'Checkpoint store', label: 'write checkpoint', kind: 'sync'},
      {from: 'Checkpoint store', to: 'Orchestrator', label: 'checkpoint_id', kind: 'reply'},
      {from: 'Orchestrator', to: 'Trainer', label: 'Restart(job_id, resume_from=checkpoint_id)', kind: 'sync'},
      {from: 'Orchestrator', to: 'Trainer', label: 'Fail(job_id) — cannot checkpoint', kind: 'async'},
      {from: 'Orchestrator', to: 'Orchestrator', label: 'stop after repeated heartbeat failures', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'heartbeat-deadline',
      title: 'Runs the heartbeat under a 60-second deadline',
      detail:
        'Each `Heartbeat` carries a **60-second** deadline. The starter uses a short 30-second timeout, so a trainer that is merely slow looks dead and gets restarted.',
      match: {
        python: {all: [/HEARTBEAT_DEADLINE_S/, /60\.0/]},
        typescript: {all: [/HEARTBEAT_DEADLINE_MS/, /60_000/]},
        go: {all: [/heartbeatDeadline/, /60 \* time\.Second/]},
        scala: {all: [/HeartbeatDeadline/, /60\.seconds/]},
        cpp: {all: [/kHeartbeatDeadline/, /60000/]},
      },
    },
    {
      id: 'checkpoint-first',
      title: 'Requests a checkpoint before restarting',
      detail:
        'On a missed heartbeat the client asks for a checkpoint **before** any restart, so a restart has a checkpoint id to resume from. The starter restarts first and never asks.',
      match: {
        python: {all: [/RequestCheckpoint/, /checkpoint_id/], order: [/RequestCheckpoint/, /restart_job/]},
        typescript: {all: [/requestCheckpoint/, /checkpointId/], order: [/requestCheckpoint/, /restartJob/]},
        go: {all: [/RequestCheckpoint/, /checkpointID/], order: [/RequestCheckpoint/, /RestartJob/]},
        scala: {all: [/requestCheckpoint/, /checkpointId/], order: [/requestCheckpoint/, /restartJob/]},
        cpp: {all: [/RequestCheckpoint/, /checkpoint_id/], order: [/RequestCheckpoint/, /RestartJob/]},
      },
    },
    {
      id: 'resume-from',
      title: 'A restart names the checkpoint it resumed from',
      detail:
        'The restart carries `resume_from` / `resumeFrom` with the checkpoint id, and the job records it. The starter restarts with no checkpoint, so the progress is silently discarded.',
      match: {
        python: {all: [/resume_from/, /checkpoint_id/]},
        typescript: {all: [/resumeFrom/, /checkpointId/]},
        go: {all: [/ResumeFrom/, /checkpointID/]},
        scala: {all: [/resumeFrom/, /checkpointId/]},
        cpp: {all: [/resume_from/, /checkpoint_id/]},
      },
    },
    {
      id: 'explicit-failure',
      title: 'Fails a trainer that cannot checkpoint',
      detail:
        'When `RequestCheckpoint` fails, the job is failed explicitly with a reason instead of being restarted blind. The starter has no failure path at all.',
      match: {
        python: {all: [/fail_job\(/, /cannot checkpoint/]},
        typescript: {all: [/failJob\(/, /cannot checkpoint/]},
        go: {all: [/FailJob\(/, /cannot checkpoint/]},
        scala: {all: [/failJob\(/, /cannot checkpoint/]},
        cpp: {all: [/FailJob\(/, /cannot checkpoint/]},
      },
    },
    {
      id: 'stop-on-repeated',
      title: 'Stops the job after repeated heartbeat failures',
      detail:
        'A failure counter is compared with a maximum (**3**) and the job is failed when it is reached, so a broken heartbeat cannot become an infinite restart loop. The starter loops forever.',
      match: {
        python: {all: [/MAX_HEARTBEAT_FAILURES/, /failures \+= 1/]},
        typescript: {all: [/MAX_HEARTBEAT_FAILURES/, /failures \+= 1/]},
        go: {all: [/maxHeartbeatFailures/, /failures\+\+/]},
        scala: {all: [/MaxHeartbeatFailures/, /failures \+= 1/]},
        cpp: {all: [/kMaxHeartbeatFailures/, /failures\+\+/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""gRPC client that drives the trainer: flawed code that restarts without a checkpoint."""
import logging

import grpc

import trainer_pb2
import trainer_pb2_grpc

logger = logging.getLogger("finetune.client")


class TrainerClient:
    def __init__(self, channel: grpc.Channel, jobs: "JobStore") -> None:
        self._stub = trainer_pb2_grpc.TrainerStub(channel)
        self._jobs = jobs

    def _heartbeat(self, job_id: str) -> bool:
        try:
            self._stub.Heartbeat(trainer_pb2.HeartbeatRequest(job_id=job_id), timeout=30.0)
            return True
        except grpc.RpcError:
            return False

    def watch(self, job_id: str, team: str) -> None:
        # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
        while True:
            if not self._heartbeat(job_id):
                self._jobs.restart_job(job_id)
`,
      solution: `"""gRPC client that drives the trainer and owns its failure policy."""
import logging

import grpc

import trainer_pb2
import trainer_pb2_grpc

logger = logging.getLogger("finetune.client")

HEARTBEAT_DEADLINE_S = 60.0
MAX_HEARTBEAT_FAILURES = 3


class TrainerClient:
    def __init__(self, channel: grpc.Channel, jobs: "JobStore") -> None:
        self._stub = trainer_pb2_grpc.TrainerStub(channel)
        self._jobs = jobs

    def _heartbeat(self, job_id: str) -> bool:
        """One heartbeat under the 60-second deadline; false means the trainer went silent."""
        try:
            self._stub.Heartbeat(
                trainer_pb2.HeartbeatRequest(job_id=job_id),
                timeout=HEARTBEAT_DEADLINE_S,
            )
            return True
        except grpc.RpcError:
            return False

    def _request_checkpoint(self, job_id: str) -> str | None:
        """Ask the trainer to checkpoint; None means it cannot, so the job must fail."""
        try:
            reply = self._stub.RequestCheckpoint(
                trainer_pb2.CheckpointRequest(job_id=job_id),
                timeout=HEARTBEAT_DEADLINE_S,
            )
            return reply.checkpoint_id
        except grpc.RpcError:
            return None

    def watch(self, job_id: str, team: str) -> None:
        failures = 0
        while True:
            if self._heartbeat(job_id):
                failures = 0
                continue
            failures += 1
            checkpoint_id = self._request_checkpoint(job_id)
            if checkpoint_id is None:
                self._jobs.fail_job(job_id, "trainer cannot checkpoint")
                return
            if failures >= MAX_HEARTBEAT_FAILURES:
                self._jobs.fail_job(job_id, "heartbeat failed repeatedly")
                return
            # A restart resumes from the checkpoint we just asked for, never from scratch.
            self._jobs.restart_job(job_id, resume_from=checkpoint_id)
`,
    },
    typescript: {
      starter: `/** gRPC client that drives the trainer: flawed code that restarts without a checkpoint. */
import * as grpc from '@grpc/grpc-js';

class Trainer {
  constructor(private readonly stub: TrainerStub, private readonly jobs: JobStore) {}

  async heartbeat(jobId: string): Promise<boolean> {
    try {
      await this.stub.heartbeat({jobId}, {deadline: Date.now() + 30_000});
      return true;
    } catch {
      return false;
    }
  }

  async watch(jobId: string): Promise<void> {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for (;;) {
      if (!(await this.heartbeat(jobId))) await this.jobs.restartJob(jobId);
    }
  }
}
`,
      solution: `/** gRPC client that drives the trainer and owns its failure policy. */
import * as grpc from '@grpc/grpc-js';

const HEARTBEAT_DEADLINE_MS = 60_000;
const MAX_HEARTBEAT_FAILURES = 3;

class Trainer {
  constructor(private readonly stub: TrainerStub, private readonly jobs: JobStore) {}

  async heartbeat(jobId: string): Promise<boolean> {
    try {
      await this.stub.heartbeat({jobId}, {deadline: Date.now() + HEARTBEAT_DEADLINE_MS});
      return true;
    } catch {
      return false;
    }
  }

  async requestCheckpoint(jobId: string): Promise<string | null> {
    try {
      const reply = await this.stub.requestCheckpoint({jobId}, {deadline: Date.now() + HEARTBEAT_DEADLINE_MS});
      return reply.checkpointId;
    } catch {
      return null;
    }
  }

  async watch(jobId: string): Promise<void> {
    let failures = 0;
    for (;;) {
      if (await this.heartbeat(jobId)) {
        failures = 0;
        continue;
      }
      failures += 1;
      const checkpointId = await this.requestCheckpoint(jobId);
      if (checkpointId === null) {
        await this.jobs.failJob(jobId, 'trainer cannot checkpoint');
        return;
      }
      if (failures >= MAX_HEARTBEAT_FAILURES) {
        await this.jobs.failJob(jobId, 'heartbeat failed repeatedly');
        return;
      }
      await this.jobs.restartJob(jobId, {resumeFrom: checkpointId});
    }
  }
}
`,
    },
    go: {
      starter: `// Package client drives the trainer over gRPC: flawed code that restarts without a checkpoint.
package client

import (
	"context"
	"time"

	pb "finetune/trainerpb"
)

type TrainerClient struct {
	stub pb.TrainerClient
	jobs *JobStore
}

func (c *TrainerClient) heartbeat(jobID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := c.stub.Heartbeat(ctx, &pb.HeartbeatRequest{JobId: jobID})
	return err == nil
}

func (c *TrainerClient) Watch(jobID string) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		if !c.heartbeat(jobID) {
			if err := c.jobs.RestartJob(jobID); err != nil {
				return err
			}
		}
	}
}
`,
      solution: `// Package client drives the trainer over gRPC and owns its failure policy.
package client

import (
	"context"
	"errors"
	"time"

	pb "finetune/trainerpb"
)

const heartbeatDeadline = 60 * time.Second

const maxHeartbeatFailures = 3

var errCannotCheckpoint = errors.New("trainer cannot checkpoint")

type TrainerClient struct {
	stub pb.TrainerClient
	jobs *JobStore
}

func (c *TrainerClient) heartbeat(jobID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), heartbeatDeadline)
	defer cancel()
	_, err := c.stub.Heartbeat(ctx, &pb.HeartbeatRequest{JobId: jobID})
	return err == nil
}

func (c *TrainerClient) requestCheckpoint(jobID string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), heartbeatDeadline)
	defer cancel()
	reply, err := c.stub.RequestCheckpoint(ctx, &pb.CheckpointRequest{JobId: jobID})
	if err != nil {
		return "", err
	}
	return reply.CheckpointId, nil
}

func (c *TrainerClient) Watch(jobID string) error {
	failures := 0
	for {
		if c.heartbeat(jobID) {
			failures = 0
			continue
		}
		failures++
		checkpointID, err := c.requestCheckpoint(jobID)
		if err != nil {
			return c.jobs.FailJob(jobID, errCannotCheckpoint.Error())
		}
		if failures >= maxHeartbeatFailures {
			return c.jobs.FailJob(jobID, "heartbeat failed repeatedly")
		}
		if err := c.jobs.RestartJob(jobID, ResumeFrom(checkpointID)); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `package finetune

import scala.concurrent.duration._

object Client {
  final class TrainerClient(stub: TrainerGrpc.TrainerStub, jobs: JobStore) {
    def heartbeat(jobId: String): Boolean =
      try {
        stub.heartbeat(HeartbeatRequest(jobId), deadline = Some(30.seconds))
        true
      } catch {
        case _: StatusRuntimeException => false
      }

    def watch(jobId: String): Unit = {
      // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
      while (true) {
        if (!heartbeat(jobId)) jobs.restartJob(jobId)
      }
    }
  }
}
`,
      solution: `package finetune

import scala.concurrent.duration._

object Client {
  val HeartbeatDeadline: FiniteDuration = 60.seconds
  val MaxHeartbeatFailures: Int = 3

  final class TrainerClient(stub: TrainerGrpc.TrainerStub, jobs: JobStore) {
    def heartbeat(jobId: String): Boolean =
      try {
        stub.heartbeat(HeartbeatRequest(jobId), deadline = Some(HeartbeatDeadline))
        true
      } catch {
        case _: StatusRuntimeException => false
      }

    def requestCheckpoint(jobId: String): Option[String] =
      try Some(stub.requestCheckpoint(CheckpointRequest(jobId)).checkpointId)
      catch { case _: StatusRuntimeException => None }

    def watch(jobId: String): Unit = {
      var failures = 0
      while (true) {
        if (heartbeat(jobId)) failures = 0
        else {
          failures += 1
          requestCheckpoint(jobId) match {
            case None => jobs.failJob(jobId, "trainer cannot checkpoint")
            case Some(checkpointId) =>
              if (failures >= MaxHeartbeatFailures) jobs.failJob(jobId, "heartbeat failed repeatedly")
              else jobs.restartJob(jobId, resumeFrom = checkpointId)
          }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `// gRPC client that drives the trainer: flawed code that restarts without a checkpoint.
#include <grpcpp/grpcpp.h>

#include "trainer.grpc.pb.h"

class TrainerClient {
 public:
  TrainerClient(std::shared_ptr<grpc::Channel> channel, JobStore* jobs)
      : stub_(Trainer::NewStub(channel)), jobs_(jobs) {}

  bool Heartbeat(const std::string& job_id) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(30));
    HeartbeatRequest req;
    req.set_job_id(job_id);
    HeartbeatReply reply;
    return stub_->Heartbeat(&ctx, req, &reply).ok();
  }

  void Watch(const std::string& job_id) {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while (true) {
      if (!Heartbeat(job_id)) jobs_->RestartJob(job_id);
    }
  }

 private:
  std::unique_ptr<Trainer::Stub> stub_;
  JobStore* jobs_;
};
`,
      solution: `// gRPC client that drives the trainer and owns its failure policy.
#include <grpcpp/grpcpp.h>

#include "trainer.grpc.pb.h"

namespace {
constexpr int kHeartbeatDeadline = 60000;  // 60 seconds, in milliseconds
constexpr int kMaxHeartbeatFailures = 3;
}  // namespace

class TrainerClient {
 public:
  TrainerClient(std::shared_ptr<grpc::Channel> channel, JobStore* jobs)
      : stub_(Trainer::NewStub(channel)), jobs_(jobs) {}

  bool Heartbeat(const std::string& job_id) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kHeartbeatDeadline));
    HeartbeatRequest req;
    req.set_job_id(job_id);
    HeartbeatReply reply;
    return stub_->Heartbeat(&ctx, req, &reply).ok();
  }

  std::string RequestCheckpoint(const std::string& job_id, bool* ok) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kHeartbeatDeadline));
    CheckpointRequest req;
    req.set_job_id(job_id);
    CheckpointReply reply;
    const auto status = stub_->RequestCheckpoint(&ctx, req, &reply);
    *ok = status.ok();
    return *ok ? reply.checkpoint_id() : std::string();
  }

  void Watch(const std::string& job_id) {
    int failures = 0;
    while (true) {
      if (Heartbeat(job_id)) {
        failures = 0;
        continue;
      }
      failures++;
      bool ok = false;
      const std::string resume_from = RequestCheckpoint(job_id, &ok);
      if (!ok) {
        jobs_->FailJob(job_id, "trainer cannot checkpoint");
        return;
      }
      if (failures >= kMaxHeartbeatFailures) {
        jobs_->FailJob(job_id, "heartbeat failed repeatedly");
        return;
      }
      jobs_->RestartJob(job_id, resume_from);
    }
  }

 private:
  std::unique_ptr<Trainer::Stub> stub_;
  JobStore* jobs_;
};
`,
    },
  },
  hints: [
    'A trainer paused on a slow checkpoint write finds its job restarted at step zero, and a trainer with a broken heartbeat is restarted all night without a failed job ever appearing.',
    'The 30-second timeout fires on ordinary stalls, and the only reaction to a miss is `restart_job`: no checkpoint request, no resume id, no failure path, no counter.',
    'Set `HEARTBEAT_DEADLINE_S = 60.0`; on a miss call `RequestCheckpoint`, pass its `checkpoint_id` as `resume_from` to `restart_job`, `fail_job` with "cannot checkpoint" otherwise, and count `failures` against `MAX_HEARTBEAT_FAILURES`.',
  ],
  debrief: `The fix has this shape because a missed heartbeat is ambiguous: the trainer may be dead, or it may be writing a checkpoint, and the client cannot tell which from silence. Asking for a checkpoint first resolves the ambiguity in the direction that preserves work; naming the resume id on the restart keeps the lineage reproducible; failing explicitly when the trainer cannot checkpoint and capping the failure count turn a silent loop into a visible, bounded failure. Production orchestrators treat the checkpoint id as part of the job record that the read path exposes, and use a lease on the trainer so a second orchestrator instance cannot restart a job that the first one is still watching.`,
};
