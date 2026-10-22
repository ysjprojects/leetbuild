import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Training calls with checkpointed progress and honest failure',
  concept: 'grpc',
  file: 'client',
  focus: ['trainer', 'checkpoints'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated gRPC client: it starts a trainer and
watches its heartbeat. It compiles, it drives the happy path, and it discards hours of progress the
first time the trainer goes quiet. Review it like the on-call owner, fix it, and prove the fix with
the checks below.

The orchestrator drives a long-running trainer over gRPC with a \`Heartbeat\` call and a
\`RequestCheckpoint\` call.

- **Heartbeat deadline.** Every \`Heartbeat\` runs under a **60-second** deadline; a trainer that
  does not answer within it has missed a heartbeat.
- **Checkpoint before restart.** A missed heartbeat is not proof of a crash. Ask the trainer to
  \`RequestCheckpoint\` **first**; only when a checkpoint id comes back may the job be restarted, and
  the restart must name the checkpoint it resumed from.
- **Honest failure.** A trainer that cannot checkpoint must be **failed explicitly** — mark the job
  failed with a reason — rather than restarted blind from scratch. A restart that silently discards
  progress is worse than a failed job, because nobody notices the wasted GPUs.
- **Stop on repeated failure.** After repeated heartbeat failures (**3**) the job is failed and the
  watch loop stops, instead of restarting forever.
- Record on the job whether a restart reused a checkpoint, so the lineage is honest.

**Failure mode the checks target.** Restarting a silent trainer from scratch throws away every hour
of training already paid for, and because the job looks \`running\` again, nobody can tell it happened.
Not recording the checkpoint a restart resumed from means a result cannot be reproduced or debugged a
week later. The repeated-failure loop is the quiet one: a trainer with a broken heartbeat becomes an
infinite restart loop that keeps burning budget and never surfaces a failure.`,
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
        'Each `Heartbeat` carries a **60-second** deadline. The draft uses a short 30-second timeout, so a trainer that is merely slow looks dead and gets restarted.',
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
        'On a missed heartbeat the client asks for a checkpoint **before** any restart, so a restart has a checkpoint id to resume from. The draft restarts first and never asks.',
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
        'The restart carries `resume_from` / `resumeFrom` with the checkpoint id, and the job records it. The draft restarts with no checkpoint, so the progress is silently discarded.',
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
        'When `RequestCheckpoint` fails, the job is failed explicitly with a reason instead of being restarted blind. The draft has no failure path at all.',
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
        'A failure counter is compared with a maximum (**3**) and the job is failed when it is reached, so a broken heartbeat cannot become an infinite restart loop. The draft loops forever.',
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
      starter: `"""gRPC client that drives the trainer (model-generated draft)."""
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
        # TODO: on a missed heartbeat ask the trainer to checkpoint first; resume the restart from
        # that checkpoint; fail the job explicitly when the trainer cannot checkpoint; and stop
        # after repeated heartbeat failures instead of looping.
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
      starter: `/** gRPC client that drives the trainer (model-generated draft). */
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
    // TODO: on a missed heartbeat ask the trainer to checkpoint first; resume the restart from that
    // checkpoint; fail the job explicitly when the trainer cannot checkpoint; and stop after
    // repeated heartbeat failures instead of looping.
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
      starter: `// Package client drives the trainer over gRPC (model-generated draft).
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
	// TODO: on a missed heartbeat ask the trainer to checkpoint first; resume the restart from that
	// checkpoint; fail the job explicitly when the trainer cannot checkpoint; and stop after
	// repeated heartbeat failures instead of looping.
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
      // TODO: on a missed heartbeat ask the trainer to checkpoint first; resume the restart from
      // that checkpoint; fail the job explicitly when the trainer cannot checkpoint; and stop
      // after repeated heartbeat failures instead of looping.
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
      starter: `// gRPC client that drives the trainer (model-generated draft).
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
    // TODO: on a missed heartbeat ask the trainer to checkpoint first; resume the restart from that
    // checkpoint; fail the job explicitly when the trainer cannot checkpoint; and stop after
    // repeated heartbeat failures instead of looping.
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
    'Give every heartbeat a 60-second deadline: a trainer that has not answered within it has missed a heartbeat, and nothing more dramatic should be assumed yet.',
    'Ask for a checkpoint before you restart. A restart that names the checkpoint it resumes from keeps the hours already trained; a restart from scratch throws them away silently.',
    'When the trainer cannot checkpoint, fail the job explicitly; and stop after repeated heartbeat failures so a broken heartbeat cannot become an infinite restart loop.',
  ],
  debrief: `The interviewer is testing whether you can review a generated long-running client against partial failure. The draft reads fine because the trainer usually answers. Four separate defects are being checked: the heartbeat deadline (60 s, not a twitchy 30 s), the checkpoint request that must precede any restart, the checkpoint id the restart resumes from and the job records, and the honest failure path plus the failure cap that stops the loop. The subtle one is the resume id: without it, a restart looks successful but the lineage cannot be reproduced, and nobody can tell that the progress was discarded. Real systems also keep the checkpoint id on the job record and expose the lineage on the read path.`,
};
