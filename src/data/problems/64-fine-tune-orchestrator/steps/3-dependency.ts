import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Trainer supervisor: checkpoint before restart, give up after three misses',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'leases'],
  file: 'supervisor',
  focus: ['supervisor', 'trainer'],
  task: `## Task

**Starting point.** The starter's \`supervise(job_id)\` watches one run on \`finetuned.Trainer\`
(\`finetuned.proto\`, a stand-in served at \`finetune/config\`'s \`TRAINER\`): it sends \`Heartbeat\` under a
30-second timeout, sleeps \`HEARTBEAT_INTERVAL_S\` (30 s) between answers, returns
\`{status: "succeeded", reason, restarts, checkpoint_ids}\` when a reply says \`done\`, and calls \`Restart\`
the moment a heartbeat fails. Against a healthy trainer it finishes in three heartbeats. It hides 5
flaws.

**Failure mode the checks target.** A missed heartbeat is not proof of a crash: a trainer writing a
large checkpoint shard answers in 45 seconds, and a 30-second timeout restarts it from scratch,
throwing away every hour since the last checkpoint. A restart that names no checkpoint cannot be
reproduced later. A trainer whose heartbeat is broken turns the loop into a restart storm that bills
the team and never reports a failure.

\`\`\`proto
service Trainer {
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatReply);            // {job_id} → {step, done}
  rpc RequestCheckpoint(CheckpointRequest) returns (CheckpointReply);  // {job_id} → {checkpoint_id}
  rpc Restart(RestartRequest) returns (RestartReply);                  // {job_id, resume_from} → {attempt}
}
\`\`\`

Requirements:

- Every call carries a **60-second** deadline (\`HEARTBEAT_DEADLINE_S\`).
- After a failed heartbeat, \`RequestCheckpoint\` first, then \`Restart\` with \`resume_from\` set to the
  returned id; every id goes into \`checkpoint_ids\`, in order.
- A checkpoint call that fails or returns an empty id ends the run: \`{status: "failed", reason:
  "checkpoint_failed"}\`, no restart.
- The **third** failed heartbeat of a run (\`MAX_HEARTBEAT_FAILURES\`) ends it as \`failed\` with
  reason \`heartbeat_lost\`.`,
  sequence: {
    participants: ['Supervisor', 'Trainer'],
    messages: [
      {from: 'Supervisor', to: 'Trainer', label: 'Heartbeat · deadline 60 s', kind: 'sync'},
      {from: 'Trainer', to: 'Supervisor', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Supervisor', to: 'Trainer', label: 'RequestCheckpoint', kind: 'sync'},
      {from: 'Trainer', to: 'Supervisor', label: '{checkpoint_id: ckpt-job-7-1}', kind: 'reply'},
      {from: 'Supervisor', to: 'Trainer', label: 'Restart {resume_from: ckpt-job-7-1}', kind: 'sync'},
      {from: 'Supervisor', to: 'Trainer', label: 'Heartbeat … {done: true}', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'heartbeat-deadline',
      title: 'Gives a busy trainer 60 seconds before calling it missed',
      detail:
        'A trainer that answers every heartbeat in 45 s is watched to the end with no restart, and each Heartbeat carries a deadline of about 60 s. The starter times out at 30 s and restarts a healthy run.',
      match: {
        python: {all: [/HEARTBEAT_DEADLINE_S\s*=\s*60(\.0)?\b/, /timeout\s*=\s*HEARTBEAT_DEADLINE_S/]},
        typescript: {
          all: [/HEARTBEAT_DEADLINE_MS\s*=\s*60_?000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*HEARTBEAT_DEADLINE_MS/],
        },
        go: {
          all: [
            /heartbeatDeadline\s*=\s*60\s*\*\s*time\.Second/,
            /context\.WithTimeout\(\s*ctx\s*,\s*heartbeatDeadline\s*\)/,
          ],
        },
        scala: {all: [/HeartbeatDeadlineMs\s*=\s*60000L?/, /withDeadlineAfter\(\s*HeartbeatDeadlineMs/]},
        cpp: {all: [/kHeartbeatDeadline\s*\{\s*60\s*\}/, /set_deadline\([^;]*kHeartbeatDeadline/]},
      },
    },
    {
      id: 'checkpoint-first',
      title: 'Asks for a checkpoint before any restart',
      detail:
        'After one missed heartbeat the supervisor calls RequestCheckpoint, then Restart, and the run finishes with one restart. The starter restarts blind.',
      match: {
        python: {order: [/stub\.RequestCheckpoint\(/, /stub\.Restart\(/]},
        typescript: {order: [/stub\.RequestCheckpoint\(/, /stub\.Restart\(/]},
        go: {order: [/stub\.RequestCheckpoint\(/, /stub\.Restart\(/]},
        scala: {order: [/\.requestCheckpoint\(/, /\.restart\(/]},
        cpp: {order: [/->RequestCheckpoint\(/, /->Restart\(/]},
      },
    },
    {
      id: 'resume-from',
      title: 'Restarts from the checkpoint it was given and records the lineage',
      detail:
        'Two missed heartbeats give two Restart calls with resume_from ckpt-job-7-1 and ckpt-job-7-2, and the result lists both in checkpoint_ids. The starter sends an empty resume_from and returns no lineage.',
      match: {
        python: {all: [/resume_from\s*=\s*\w+\.checkpoint_id/]},
        typescript: {all: [/resume_from:\s*\w+\.checkpoint_id/]},
        go: {all: [/ResumeFrom:\s*\w+\.(GetCheckpointId\(\)|CheckpointId)/]},
        scala: {all: [/resumeFrom\s*=\s*\w+\.checkpointId/]},
        cpp: {all: [/set_resume_from\(\s*\w+\.checkpoint_id\(\)\s*\)/]},
      },
    },
    {
      id: 'checkpoint-failure',
      title: 'Fails the run when the trainer cannot checkpoint',
      detail:
        'A missed heartbeat followed by a failed RequestCheckpoint ends as failed with reason checkpoint_failed and no Restart call. The starter restarts anyway and reports success.',
      match: {
        python: {all: [/["']checkpoint_failed["']/]},
        typescript: {all: [/["']checkpoint_failed["']/]},
        go: {all: [/"checkpoint_failed"/]},
        scala: {all: [/"checkpoint_failed"/]},
        cpp: {all: [/"checkpoint_failed"/]},
      },
    },
    {
      id: 'stop-on-repeated',
      title: 'Stops after the third failed heartbeat',
      detail:
        'A trainer whose heartbeat keeps failing gets three Heartbeat calls and two restarts, then the run ends as failed with reason heartbeat_lost. The starter restarts on every failure until the trainer answers.',
      match: {
        python: {all: [/MAX_HEARTBEAT_FAILURES/, /["']heartbeat_lost["']/]},
        typescript: {all: [/MAX_HEARTBEAT_FAILURES/, /["']heartbeat_lost["']/]},
        go: {all: [/maxHeartbeatFailures/, /"heartbeat_lost"/]},
        scala: {all: [/MaxHeartbeatFailures/, /"heartbeat_lost"/]},
        cpp: {all: [/kMaxHeartbeatFailures/, /"heartbeat_lost"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import finetuned_pb2
import finetuned_pb2_grpc
from finetune.config import TRAINER

logger = logging.getLogger("finetune.supervisor")

HEARTBEAT_TIMEOUT_S = 30
HEARTBEAT_INTERVAL_S = 30

channel = grpc.insecure_channel(TRAINER)
stub = finetuned_pb2_grpc.TrainerStub(channel)


def supervise(job_id: str) -> dict:
    """Watch one training run to its end: {status, reason, restarts, checkpoint_ids}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    restarts = 0
    while True:
        try:
            beat = stub.Heartbeat(finetuned_pb2.HeartbeatRequest(job_id=job_id), timeout=HEARTBEAT_TIMEOUT_S)
        except grpc.RpcError as err:
            logger.warning("heartbeat missed job=%s code=%s: restarting", job_id, err.code())
            stub.Restart(finetuned_pb2.RestartRequest(job_id=job_id), timeout=HEARTBEAT_TIMEOUT_S)
            restarts += 1
            continue
        if beat.done:
            return {"status": "succeeded", "reason": "", "restarts": restarts, "checkpoint_ids": []}
        time.sleep(HEARTBEAT_INTERVAL_S)
`,
      solution: `import logging
import time

import grpc

import finetuned_pb2
import finetuned_pb2_grpc
from finetune.config import TRAINER

logger = logging.getLogger("finetune.supervisor")

HEARTBEAT_DEADLINE_S = 60
HEARTBEAT_INTERVAL_S = 30
MAX_HEARTBEAT_FAILURES = 3

channel = grpc.insecure_channel(TRAINER)
stub = finetuned_pb2_grpc.TrainerStub(channel)


def supervise(job_id: str) -> dict:
    """Watch one training run to its end: {status, reason, restarts, checkpoint_ids}."""
    failures = 0
    checkpoint_ids: list[str] = []

    def failed(reason: str) -> dict:
        logger.warning("run failed job=%s reason=%s checkpoints=%s", job_id, reason, checkpoint_ids)
        return {"status": "failed", "reason": reason, "restarts": len(checkpoint_ids), "checkpoint_ids": checkpoint_ids}

    while True:
        try:
            beat = stub.Heartbeat(finetuned_pb2.HeartbeatRequest(job_id=job_id), timeout=HEARTBEAT_DEADLINE_S)
        except grpc.RpcError as err:
            failures += 1
            logger.warning("heartbeat missed job=%s code=%s failures=%d", job_id, err.code(), failures)
            if failures >= MAX_HEARTBEAT_FAILURES:
                return failed("heartbeat_lost")
            try:
                checkpoint = stub.RequestCheckpoint(finetuned_pb2.CheckpointRequest(job_id=job_id), timeout=HEARTBEAT_DEADLINE_S)
            except grpc.RpcError:
                return failed("checkpoint_failed")
            if checkpoint.checkpoint_id == "":
                return failed("checkpoint_failed")
            checkpoint_ids.append(checkpoint.checkpoint_id)
            try:
                stub.Restart(
                    finetuned_pb2.RestartRequest(job_id=job_id, resume_from=checkpoint.checkpoint_id),
                    timeout=HEARTBEAT_DEADLINE_S,
                )
            except grpc.RpcError:
                return failed("restart_failed")
            continue
        if beat.done:
            return {"status": "succeeded", "reason": "", "restarts": len(checkpoint_ids), "checkpoint_ids": checkpoint_ids}
        time.sleep(HEARTBEAT_INTERVAL_S)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TRAINER} from 'finetune/config';

export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;

interface CallOptions {
  deadline: number;
}
interface TrainerClient {
  Heartbeat(request: {job_id: string}, options?: CallOptions): Promise<{step: string; done: boolean}>;
  RequestCheckpoint(request: {job_id: string}, options?: CallOptions): Promise<{checkpoint_id: string}>;
  Restart(request: {job_id: string; resume_from?: string}, options?: CallOptions): Promise<{attempt: number}>;
}

const {finetuned} = grpc.loadPackageDefinition(protoLoader.loadSync('finetuned.proto')) as unknown as {
  finetuned: {Trainer: new (target: string, credentials: grpc.ChannelCredentials) => TrainerClient};
};
const stub = new finetuned.Trainer(TRAINER, grpc.credentials.createInsecure());

export interface Supervision {
  status: string;
  reason: string;
  restarts: number;
  checkpoint_ids: string[];
}

/** Watch one training run to its end. */
export async function supervise(jobId: string): Promise<Supervision> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  let restarts = 0;
  for (;;) {
    let beat: {done: boolean};
    try {
      beat = await stub.Heartbeat({job_id: jobId}, {deadline: Date.now() + HEARTBEAT_TIMEOUT_MS});
    } catch (err) {
      console.warn(\`heartbeat missed job=\${jobId} code=\${(err as grpc.ServiceError).code}: restarting\`);
      await stub.Restart({job_id: jobId}, {deadline: Date.now() + HEARTBEAT_TIMEOUT_MS});
      restarts += 1;
      continue;
    }
    if (beat.done) return {status: 'succeeded', reason: '', restarts, checkpoint_ids: []};
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TRAINER} from 'finetune/config';

export const HEARTBEAT_DEADLINE_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MAX_HEARTBEAT_FAILURES = 3;

interface CallOptions {
  deadline: number;
}
interface TrainerClient {
  Heartbeat(request: {job_id: string}, options?: CallOptions): Promise<{step: string; done: boolean}>;
  RequestCheckpoint(request: {job_id: string}, options?: CallOptions): Promise<{checkpoint_id: string}>;
  Restart(request: {job_id: string; resume_from?: string}, options?: CallOptions): Promise<{attempt: number}>;
}

const {finetuned} = grpc.loadPackageDefinition(protoLoader.loadSync('finetuned.proto')) as unknown as {
  finetuned: {Trainer: new (target: string, credentials: grpc.ChannelCredentials) => TrainerClient};
};
const stub = new finetuned.Trainer(TRAINER, grpc.credentials.createInsecure());

export interface Supervision {
  status: string;
  reason: string;
  restarts: number;
  checkpoint_ids: string[];
}

/** Watch one training run to its end. */
export async function supervise(jobId: string): Promise<Supervision> {
  let failures = 0;
  const checkpointIds: string[] = [];
  const failed = (reason: string): Supervision => {
    console.warn(\`run failed job=\${jobId} reason=\${reason} checkpoints=\${checkpointIds.join(',')}\`);
    return {status: 'failed', reason, restarts: checkpointIds.length, checkpoint_ids: checkpointIds};
  };

  for (;;) {
    let beat: {done: boolean};
    try {
      beat = await stub.Heartbeat({job_id: jobId}, {deadline: Date.now() + HEARTBEAT_DEADLINE_MS});
    } catch (err) {
      failures += 1;
      console.warn(\`heartbeat missed job=\${jobId} code=\${(err as grpc.ServiceError).code} failures=\${failures}\`);
      if (failures >= MAX_HEARTBEAT_FAILURES) return failed('heartbeat_lost');
      let checkpoint: {checkpoint_id: string};
      try {
        checkpoint = await stub.RequestCheckpoint({job_id: jobId}, {deadline: Date.now() + HEARTBEAT_DEADLINE_MS});
      } catch {
        return failed('checkpoint_failed');
      }
      if (checkpoint.checkpoint_id === '') return failed('checkpoint_failed');
      checkpointIds.push(checkpoint.checkpoint_id);
      try {
        await stub.Restart({job_id: jobId, resume_from: checkpoint.checkpoint_id}, {deadline: Date.now() + HEARTBEAT_DEADLINE_MS});
      } catch {
        return failed('restart_failed');
      }
      continue;
    }
    if (beat.done) return {status: 'succeeded', reason: '', restarts: checkpointIds.length, checkpoint_ids: checkpointIds};
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"finetune/config" // config.Trainer — provided
	pb "finetune/gen/finetuned"
)

const (
	heartbeatTimeout  = 30 * time.Second
	heartbeatInterval = 30 * time.Second
)

var conn, _ = grpc.NewClient(config.Trainer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewTrainerClient(conn)

// Supervision is how one watched run ended.
type Supervision struct {
	Status        string
	Reason        string
	Restarts      int
	CheckpointIDs []string
}

// supervise watches one training run to its end.
func supervise(ctx context.Context, jobID string) (Supervision, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	restarts := 0
	for {
		beatCtx, cancel := context.WithTimeout(ctx, heartbeatTimeout)
		beat, err := stub.Heartbeat(beatCtx, &pb.HeartbeatRequest{JobId: jobID})
		cancel()
		if err != nil {
			log.Printf("heartbeat missed job=%s code=%s: restarting", jobID, status.Code(err))
			restartCtx, cancelRestart := context.WithTimeout(ctx, heartbeatTimeout)
			_, err = stub.Restart(restartCtx, &pb.RestartRequest{JobId: jobID})
			cancelRestart()
			if err != nil {
				return Supervision{}, err
			}
			restarts++
			continue
		}
		if beat.GetDone() {
			return Supervision{Status: "succeeded", Restarts: restarts, CheckpointIDs: []string{}}, nil
		}
		time.Sleep(heartbeatInterval)
	}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"finetune/config" // config.Trainer — provided
	pb "finetune/gen/finetuned"
)

const (
	heartbeatDeadline    = 60 * time.Second
	heartbeatInterval    = 30 * time.Second
	maxHeartbeatFailures = 3
)

var conn, _ = grpc.NewClient(config.Trainer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewTrainerClient(conn)

// Supervision is how one watched run ended.
type Supervision struct {
	Status        string
	Reason        string
	Restarts      int
	CheckpointIDs []string
}

// supervise watches one training run to its end.
func supervise(ctx context.Context, jobID string) (Supervision, error) {
	failures := 0
	checkpoints := []string{}
	failed := func(reason string) (Supervision, error) {
		log.Printf("run failed job=%s reason=%s checkpoints=%v", jobID, reason, checkpoints)
		return Supervision{Status: "failed", Reason: reason, Restarts: len(checkpoints), CheckpointIDs: checkpoints}, nil
	}
	for {
		beatCtx, cancel := context.WithTimeout(ctx, heartbeatDeadline)
		beat, err := stub.Heartbeat(beatCtx, &pb.HeartbeatRequest{JobId: jobID})
		cancel()
		if err == nil {
			if beat.GetDone() {
				return Supervision{Status: "succeeded", Restarts: len(checkpoints), CheckpointIDs: checkpoints}, nil
			}
			time.Sleep(heartbeatInterval)
			continue
		}
		failures++
		log.Printf("heartbeat missed job=%s code=%s failures=%d", jobID, status.Code(err), failures)
		if failures >= maxHeartbeatFailures {
			return failed("heartbeat_lost")
		}
		checkpointCtx, cancelCheckpoint := context.WithTimeout(ctx, heartbeatDeadline)
		checkpoint, err := stub.RequestCheckpoint(checkpointCtx, &pb.CheckpointRequest{JobId: jobID})
		cancelCheckpoint()
		if err != nil || checkpoint.GetCheckpointId() == "" {
			return failed("checkpoint_failed")
		}
		checkpoints = append(checkpoints, checkpoint.GetCheckpointId())
		restartCtx, cancelRestart := context.WithTimeout(ctx, heartbeatDeadline)
		_, err = stub.Restart(restartCtx, &pb.RestartRequest{JobId: jobID, ResumeFrom: checkpoint.GetCheckpointId()})
		cancelRestart()
		if err != nil {
			return failed("restart_failed")
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import finetune.Config
import finetuned.finetuned.{HeartbeatRequest, RestartRequest, TrainerGrpc}

/** How one watched run ended. */
final case class Supervision(status: String, reason: String, restarts: Int, checkpointIds: List[String])

object Supervisor {
  val HeartbeatTimeoutMs = 30000L
  val HeartbeatIntervalMs = 30000L

  private val channel = ManagedChannelBuilder.forTarget(Config.Trainer).usePlaintext().build()
  private val stub = TrainerGrpc.blockingStub(channel)

  /** Watch one training run to its end. */
  def supervise(jobId: String): Supervision = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    var restarts = 0
    while (true) {
      try {
        val beat = stub.withDeadlineAfter(HeartbeatTimeoutMs, TimeUnit.MILLISECONDS).heartbeat(HeartbeatRequest(jobId = jobId))
        if (beat.done) return Supervision("succeeded", "", restarts, Nil)
        Thread.sleep(HeartbeatIntervalMs)
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"heartbeat missed job=$jobId code=\${e.getStatus.getCode}: restarting")
          stub.withDeadlineAfter(HeartbeatTimeoutMs, TimeUnit.MILLISECONDS).restart(RestartRequest(jobId = jobId))
          restarts += 1
      }
    }
    Supervision("failed", "unreachable", restarts, Nil)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable.ListBuffer

import finetune.Config
import finetuned.finetuned.{CheckpointRequest, HeartbeatRequest, RestartRequest, TrainerGrpc}

/** How one watched run ended. */
final case class Supervision(status: String, reason: String, restarts: Int, checkpointIds: List[String])

object Supervisor {
  val HeartbeatDeadlineMs = 60000L
  val HeartbeatIntervalMs = 30000L
  val MaxHeartbeatFailures = 3

  private val channel = ManagedChannelBuilder.forTarget(Config.Trainer).usePlaintext().build()
  private val stub = TrainerGrpc.blockingStub(channel)

  private def bounded = stub.withDeadlineAfter(HeartbeatDeadlineMs, TimeUnit.MILLISECONDS)

  /** Watch one training run to its end. */
  def supervise(jobId: String): Supervision = {
    var failures = 0
    val checkpointIds = ListBuffer[String]()
    def failed(reason: String): Supervision = {
      System.err.println(s"run failed job=$jobId reason=$reason checkpoints=\${checkpointIds.mkString(",")}")
      Supervision("failed", reason, checkpointIds.size, checkpointIds.toList)
    }

    while (true) {
      val beat =
        try Some(bounded.heartbeat(HeartbeatRequest(jobId = jobId)))
        catch {
          case e: StatusRuntimeException =>
            failures += 1
            System.err.println(s"heartbeat missed job=$jobId code=\${e.getStatus.getCode} failures=$failures")
            None
        }
      beat match {
        case Some(reply) =>
          if (reply.done) return Supervision("succeeded", "", checkpointIds.size, checkpointIds.toList)
          Thread.sleep(HeartbeatIntervalMs)
        case None =>
          if (failures >= MaxHeartbeatFailures) return failed("heartbeat_lost")
          val checkpoint =
            try bounded.requestCheckpoint(CheckpointRequest(jobId = jobId))
            catch { case _: StatusRuntimeException => return failed("checkpoint_failed") }
          if (checkpoint.checkpointId.isEmpty) return failed("checkpoint_failed")
          checkpointIds += checkpoint.checkpointId
          try bounded.restart(RestartRequest(jobId = jobId, resumeFrom = checkpoint.checkpointId))
          catch { case _: StatusRuntimeException => return failed("restart_failed") }
      }
    }
    failed("unreachable")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "finetune/config.h"  // config::kTrainer — provided
#include "finetuned.grpc.pb.h"

constexpr std::chrono::seconds kHeartbeatTimeout{30};
constexpr std::chrono::seconds kHeartbeatInterval{30};

auto channel = grpc::CreateChannel(config::kTrainer, grpc::InsecureChannelCredentials());
auto stub = finetuned::Trainer::NewStub(channel);

// How one watched run ended.
struct Supervision {
  std::string status;
  std::string reason;
  int restarts = 0;
  std::vector<std::string> checkpoint_ids;
};

// Watch one training run to its end.
Supervision supervise(const std::string& job_id) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  int restarts = 0;
  for (;;) {
    grpc::ClientContext beat_ctx;
    beat_ctx.set_deadline(std::chrono::system_clock::now() + kHeartbeatTimeout);
    finetuned::HeartbeatRequest beat_request;
    beat_request.set_job_id(job_id);
    finetuned::HeartbeatReply beat;
    const grpc::Status status = stub->Heartbeat(&beat_ctx, beat_request, &beat);
    if (!status.ok()) {
      std::cerr << "heartbeat missed job=" << job_id << " code=" << status.error_code() << ": restarting\\n";
      grpc::ClientContext restart_ctx;
      restart_ctx.set_deadline(std::chrono::system_clock::now() + kHeartbeatTimeout);
      finetuned::RestartRequest restart;
      restart.set_job_id(job_id);
      finetuned::RestartReply restarted;
      stub->Restart(&restart_ctx, restart, &restarted);
      restarts++;
      continue;
    }
    if (beat.done()) return {"succeeded", "", restarts, {}};
    std::this_thread::sleep_for(kHeartbeatInterval);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "finetune/config.h"  // config::kTrainer — provided
#include "finetuned.grpc.pb.h"

constexpr std::chrono::seconds kHeartbeatDeadline{60};
constexpr std::chrono::seconds kHeartbeatInterval{30};
constexpr int kMaxHeartbeatFailures = 3;

auto channel = grpc::CreateChannel(config::kTrainer, grpc::InsecureChannelCredentials());
auto stub = finetuned::Trainer::NewStub(channel);

// How one watched run ended.
struct Supervision {
  std::string status;
  std::string reason;
  int restarts = 0;
  std::vector<std::string> checkpoint_ids;
};

// Watch one training run to its end.
Supervision supervise(const std::string& job_id) {
  int failures = 0;
  std::vector<std::string> checkpoint_ids;
  const auto failed = [&](const std::string& reason) {
    std::cerr << "run failed job=" << job_id << " reason=" << reason << "\\n";
    return Supervision{"failed", reason, static_cast<int>(checkpoint_ids.size()), checkpoint_ids};
  };

  for (;;) {
    grpc::ClientContext beat_ctx;
    beat_ctx.set_deadline(std::chrono::system_clock::now() + kHeartbeatDeadline);
    finetuned::HeartbeatRequest beat_request;
    beat_request.set_job_id(job_id);
    finetuned::HeartbeatReply beat;
    const grpc::Status status = stub->Heartbeat(&beat_ctx, beat_request, &beat);
    if (status.ok()) {
      if (beat.done()) return {"succeeded", "", static_cast<int>(checkpoint_ids.size()), checkpoint_ids};
      std::this_thread::sleep_for(kHeartbeatInterval);
      continue;
    }
    failures++;
    std::cerr << "heartbeat missed job=" << job_id << " code=" << status.error_code() << " failures=" << failures << "\\n";
    if (failures >= kMaxHeartbeatFailures) return failed("heartbeat_lost");

    grpc::ClientContext checkpoint_ctx;
    checkpoint_ctx.set_deadline(std::chrono::system_clock::now() + kHeartbeatDeadline);
    finetuned::CheckpointRequest checkpoint_request;
    checkpoint_request.set_job_id(job_id);
    finetuned::CheckpointReply checkpoint;
    if (!stub->RequestCheckpoint(&checkpoint_ctx, checkpoint_request, &checkpoint).ok() || checkpoint.checkpoint_id().empty())
      return failed("checkpoint_failed");
    checkpoint_ids.push_back(checkpoint.checkpoint_id());

    grpc::ClientContext restart_ctx;
    restart_ctx.set_deadline(std::chrono::system_clock::now() + kHeartbeatDeadline);
    finetuned::RestartRequest restart;
    restart.set_job_id(job_id);
    restart.set_resume_from(checkpoint.checkpoint_id());
    finetuned::RestartReply restarted;
    if (!stub->Restart(&restart_ctx, restart, &restarted).ok()) return failed("restart_failed");
  }
}
`,
    },
  },
  harness: {
    python: `import grpc

import finetuned_pb2
import finetuned_pb2_grpc
from finetune import config

JOB = "job-7"


class TrainerServicer(finetuned_pb2_grpc.TrainerServicer):
    """The stand-in trainer: done on its third answered heartbeat; a restarted run answers promptly."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.beats = {}
        self.checkpoints = {}
        self.restarts = {}

    def Heartbeat(self, request, context):
        self.beats[request.job_id] = self.beats.get(request.job_id, 0) + 1
        n = self.beats[request.job_id]
        return finetuned_pb2.HeartbeatReply(step=n * 100, done=n >= 3)

    def RequestCheckpoint(self, request, context):
        self.checkpoints[request.job_id] = self.checkpoints.get(request.job_id, 0) + 1
        return finetuned_pb2.CheckpointReply(checkpoint_id=f"ckpt-{request.job_id}-{self.checkpoints[request.job_id]}")

    def Restart(self, request, context):
        self.restarts[request.job_id] = self.restarts.get(request.job_id, 0) + 1
        self.ctx.grpc.set_latency("Heartbeat", 0.0, config.TRAINER)
        return finetuned_pb2.RestartReply(attempt=self.restarts[request.job_id])


def _world(ctx):
    ctx.grpc.serve(finetuned_pb2_grpc.add_TrainerServicer_to_server, TrainerServicer(ctx), config.TRAINER)
    return ctx.load("supervisor")


def _calls(ctx, method):
    return ctx.grpc.calls_to(method)


def _expect(result, status, reason=None):
    assert isinstance(result, dict), f"supervise must return a dict, got {type(result).__name__}"
    assert result.get("status") == status, f"expected status {status!r}, got {result}"
    if reason is not None:
        assert result.get("reason") == reason, f"expected reason {reason!r}, got {result}"


def check_heartbeat_deadline(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Heartbeat", 45.0, config.TRAINER)
    result = m.supervise(JOB)
    restarts = _calls(ctx, "Restart")
    assert restarts == [], f"a trainer answering heartbeats in 45 s (busy writing a checkpoint shard) was restarted {len(restarts)} time(s): a deadline under 60 s threw away a healthy run's progress"
    _expect(result, "succeeded")
    assert result.get("restarts") == 0, f"a healthy run has no restarts: {result}"
    beats = _calls(ctx, "Heartbeat")
    assert len(beats) == 3, f"the run finishes on its third heartbeat, saw {len(beats)} Heartbeat calls"
    for call in beats:
        assert call.timeout is not None and 55 <= call.timeout <= 65, f"every Heartbeat carries a 60 s deadline (HEARTBEAT_DEADLINE_S), one carried {call.timeout}"


def check_checkpoint_first(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Heartbeat", grpc.StatusCode.UNAVAILABLE, "trainer node rebooting", times=1, target=config.TRAINER)
    result = m.supervise(JOB)
    order = [c.path.rsplit("/", 1)[-1] for c in ctx.grpc.calls if c.path.endswith(("/RequestCheckpoint", "/Restart"))]
    assert order == ["RequestCheckpoint", "Restart"], f"after one missed heartbeat the calls were {order}: ask the trainer for a checkpoint, then restart from it. A blind restart throws away every hour since the last checkpoint"
    _expect(result, "succeeded")
    assert result.get("restarts") == 1, f"one missed heartbeat, one restart: {result}"


def check_resume_from(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Heartbeat", grpc.StatusCode.UNAVAILABLE, "trainer node rebooting", times=2, target=config.TRAINER)
    result = m.supervise(JOB)
    resumed = [c.request.resume_from for c in _calls(ctx, "Restart")]
    assert resumed == ["ckpt-job-7-1", "ckpt-job-7-2"], f"the restarts resumed from {resumed}: each Restart names the checkpoint RequestCheckpoint just returned, or the run cannot be reproduced"
    _expect(result, "succeeded")
    assert result.get("checkpoint_ids") == ["ckpt-job-7-1", "ckpt-job-7-2"], f"the result must carry the checkpoint lineage in order: {result}"
    assert result.get("restarts") == 2, f"two missed heartbeats, two restarts: {result}"


def check_checkpoint_failure(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Heartbeat", grpc.StatusCode.UNAVAILABLE, "trainer node rebooting", times=1, target=config.TRAINER)
    ctx.grpc.fail("RequestCheckpoint", grpc.StatusCode.FAILED_PRECONDITION, "checkpoint volume full", times=1, target=config.TRAINER)
    result = m.supervise(JOB)
    restarts = _calls(ctx, "Restart")
    assert restarts == [], f"the trainer could not checkpoint and the supervisor restarted it anyway ({len(restarts)} Restart calls): the run must fail with a reason instead"
    _expect(result, "failed", "checkpoint_failed")
    assert len(_calls(ctx, "Heartbeat")) == 1, f"a failed run is not watched further: saw {len(_calls(ctx, 'Heartbeat'))} Heartbeat calls"


def check_stop_on_repeated(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Heartbeat", grpc.StatusCode.UNAVAILABLE, "trainer wedged", times=10, target=config.TRAINER)
    result = m.supervise(JOB)
    beats, restarts = len(_calls(ctx, "Heartbeat")), len(_calls(ctx, "Restart"))
    assert beats == 3 and restarts == 2, f"a heartbeat that keeps failing got {beats} Heartbeat calls and {restarts} restarts, expected 3 and 2: the third failure (MAX_HEARTBEAT_FAILURES) ends the run"
    _expect(result, "failed", "heartbeat_lost")
`,
    typescript: `const JOB = 'job-7';

function world(ctx) {
  const {finetuned} = ctx.proto('finetuned.proto');
  const config = ctx.load('/support/finetune/config.ts');
  const beats: Record<string, number> = {};
  const checkpoints: Record<string, number> = {};
  const restarts: Record<string, number> = {};
  // RequestCheckpoint and Restart in the order the trainer served them.
  const served: string[] = [];
  // The stand-in trainer: done on its third answered heartbeat; a restarted run answers promptly.
  ctx.grpc.serve(finetuned.Trainer.service, {
    Heartbeat(call, callback) {
      const id = call.request.job_id;
      beats[id] = (beats[id] ?? 0) + 1;
      callback(null, {step: beats[id] * 100, done: beats[id] >= 3});
    },
    RequestCheckpoint(call, callback) {
      const id = call.request.job_id;
      served.push('RequestCheckpoint');
      checkpoints[id] = (checkpoints[id] ?? 0) + 1;
      callback(null, {checkpoint_id: \`ckpt-\${id}-\${checkpoints[id]}\`});
    },
    Restart(call, callback) {
      const id = call.request.job_id;
      served.push('Restart');
      restarts[id] = (restarts[id] ?? 0) + 1;
      ctx.grpc.setLatency('Heartbeat', 0, config.TRAINER);
      callback(null, {attempt: restarts[id]});
    },
  }, config.TRAINER);
  return {m: ctx.load('supervisor'), config, served};
}

const calls = (ctx, method: string) => ctx.grpc.callsTo(method);

function expect(result, status: string, reason?: string) {
  assert(result !== null && typeof result === 'object', \`supervise must resolve to an object, got \${JSON.stringify(result)}\`);
  assert.equal(result.status, status, \`expected status \${status}, got \${JSON.stringify(result)}\`);
  if (reason !== undefined) assert.equal(result.reason, reason, \`expected reason \${reason}, got \${JSON.stringify(result)}\`);
}

export async function check_heartbeat_deadline(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.setLatency('Heartbeat', 45, config.TRAINER);
  const result = await m.supervise(JOB);
  const restarts = calls(ctx, 'Restart');
  assert.equal(restarts.length, 0, \`a trainer answering heartbeats in 45 s (busy writing a checkpoint shard) was restarted \${restarts.length} time(s): a deadline under 60 s threw away a healthy run's progress\`);
  expect(result, 'succeeded');
  assert.equal(result.restarts, 0, \`a healthy run has no restarts: \${JSON.stringify(result)}\`);
  const beats = calls(ctx, 'Heartbeat');
  assert.equal(beats.length, 3, \`the run finishes on its third heartbeat, saw \${beats.length} Heartbeat calls\`);
  for (const call of beats)
    assert(call.timeout !== null && call.timeout >= 55 && call.timeout <= 65, \`every Heartbeat carries a 60 s deadline (HEARTBEAT_DEADLINE_MS), one carried \${call.timeout}\`);
}

export async function check_checkpoint_first(ctx) {
  const {m, config, served} = world(ctx);
  ctx.grpc.fail('Heartbeat', ctx.grpc.status.UNAVAILABLE, 'trainer node rebooting', 1, config.TRAINER);
  const result = await m.supervise(JOB);
  const order = [...served];
  assert.deepEqual(order, ['RequestCheckpoint', 'Restart'], \`after one missed heartbeat the calls were \${JSON.stringify(order)}: ask the trainer for a checkpoint, then restart from it. A blind restart throws away every hour since the last checkpoint\`);
  expect(result, 'succeeded');
  assert.equal(result.restarts, 1, \`one missed heartbeat, one restart: \${JSON.stringify(result)}\`);
}

export async function check_resume_from(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Heartbeat', ctx.grpc.status.UNAVAILABLE, 'trainer node rebooting', 2, config.TRAINER);
  const result = await m.supervise(JOB);
  const resumed = calls(ctx, 'Restart').map(c => c.request.resume_from);
  assert.deepEqual(resumed, ['ckpt-job-7-1', 'ckpt-job-7-2'], \`the restarts resumed from \${JSON.stringify(resumed)}: each Restart names the checkpoint RequestCheckpoint just returned, or the run cannot be reproduced\`);
  expect(result, 'succeeded');
  assert.deepEqual(result.checkpoint_ids, ['ckpt-job-7-1', 'ckpt-job-7-2'], \`the result must carry the checkpoint lineage in order: \${JSON.stringify(result)}\`);
  assert.equal(result.restarts, 2, \`two missed heartbeats, two restarts: \${JSON.stringify(result)}\`);
}

export async function check_checkpoint_failure(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Heartbeat', ctx.grpc.status.UNAVAILABLE, 'trainer node rebooting', 1, config.TRAINER);
  ctx.grpc.fail('RequestCheckpoint', ctx.grpc.status.FAILED_PRECONDITION, 'checkpoint volume full', 1, config.TRAINER);
  const result = await m.supervise(JOB);
  const restarts = calls(ctx, 'Restart');
  assert.equal(restarts.length, 0, \`the trainer could not checkpoint and the supervisor restarted it anyway (\${restarts.length} Restart calls): the run must fail with a reason instead\`);
  expect(result, 'failed', 'checkpoint_failed');
  assert.equal(calls(ctx, 'Heartbeat').length, 1, \`a failed run is not watched further: saw \${calls(ctx, 'Heartbeat').length} Heartbeat calls\`);
}

export async function check_stop_on_repeated(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Heartbeat', ctx.grpc.status.UNAVAILABLE, 'trainer wedged', 10, config.TRAINER);
  const result = await m.supervise(JOB);
  const beats = calls(ctx, 'Heartbeat').length;
  const restarts = calls(ctx, 'Restart').length;
  assert(beats === 3 && restarts === 2, \`a heartbeat that keeps failing got \${beats} Heartbeat calls and \${restarts} restarts, expected 3 and 2: the third failure (MAX_HEARTBEAT_FAILURES) ends the run\`);
  expect(result, 'failed', 'heartbeat_lost');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"finetune/config"
	pb "finetune/gen/finetuned"

	"leetbuild/harness"
)

const supervisedJob = "job-7"

// trainerPeer is the stand-in trainer: done on its third answered heartbeat; a restarted run answers promptly.
type trainerPeer struct {
	pb.UnimplementedTrainerServer
	ctx         *harness.Ctx
	beats       map[string]int64
	checkpoints map[string]int
	restarts    map[string]int32
}

func (p *trainerPeer) Heartbeat(_ context.Context, req *pb.HeartbeatRequest) (*pb.HeartbeatReply, error) {
	p.beats[req.GetJobId()]++
	n := p.beats[req.GetJobId()]
	return &pb.HeartbeatReply{Step: n * 100, Done: n >= 3}, nil
}

func (p *trainerPeer) RequestCheckpoint(_ context.Context, req *pb.CheckpointRequest) (*pb.CheckpointReply, error) {
	p.checkpoints[req.GetJobId()]++
	return &pb.CheckpointReply{CheckpointId: fmt.Sprintf("ckpt-%s-%d", req.GetJobId(), p.checkpoints[req.GetJobId()])}, nil
}

func (p *trainerPeer) Restart(_ context.Context, req *pb.RestartRequest) (*pb.RestartReply, error) {
	p.restarts[req.GetJobId()]++
	p.ctx.GRPC.SetLatency("Heartbeat", 0, config.Trainer)
	return &pb.RestartReply{Attempt: p.restarts[req.GetJobId()]}, nil
}

func supervisorWorld(ctx *harness.Ctx) {
	peer := &trainerPeer{ctx: ctx, beats: map[string]int64{}, checkpoints: map[string]int{}, restarts: map[string]int32{}}
	pb.RegisterTrainerServer(ctx.GRPC.Server(config.Trainer), peer)
}

func supervisorRun(ctx *harness.Ctx) Supervision {
	result, err := supervise(context.Background(), supervisedJob)
	ctx.NoError(err, "supervise(%s)", supervisedJob)
	return result
}

func supervisorCalls(ctx *harness.Ctx, method string) []harness.Call {
	return ctx.GRPC.CallsTo(method, "")
}

func supervisorExpect(ctx *harness.Ctx, result Supervision, status, reason string) {
	ctx.Equal(result.Status, status, "the run's status (%+v)", result)
	if reason != "" {
		ctx.Equal(result.Reason, reason, "the run's reason (%+v)", result)
	}
}

func CheckHeartbeatDeadline(ctx *harness.Ctx) {
	supervisorWorld(ctx)
	ctx.GRPC.SetLatency("Heartbeat", 45, config.Trainer)
	result := supervisorRun(ctx)
	restarts := len(supervisorCalls(ctx, "Restart"))
	ctx.Equal(restarts, 0, "a trainer answering heartbeats in 45 s (busy writing a checkpoint shard) was restarted: a deadline under 60 s threw away a healthy run's progress; Restart calls")
	supervisorExpect(ctx, result, "succeeded", "")
	ctx.Equal(result.Restarts, 0, "a healthy run has no restarts")
	beats := supervisorCalls(ctx, "Heartbeat")
	ctx.Equal(len(beats), 3, "the run finishes on its third heartbeat; Heartbeat calls")
	for _, call := range beats {
		ctx.Assert(call.HasDeadline() && call.Timeout >= 55*time.Second && call.Timeout <= 65*time.Second, "every Heartbeat carries a 60 s deadline (heartbeatDeadline), one carried %v", call.Timeout)
	}
}

func CheckCheckpointFirst(ctx *harness.Ctx) {
	supervisorWorld(ctx)
	ctx.GRPC.Fail("Heartbeat", codes.Unavailable, "trainer node rebooting", 1, config.Trainer)
	result := supervisorRun(ctx)
	order := []string{}
	for _, call := range ctx.GRPC.Calls() {
		name := call.Method[strings.LastIndex(call.Method, "/")+1:]
		if name == "RequestCheckpoint" || name == "Restart" {
			order = append(order, name)
		}
	}
	ctx.Equal(order, []string{"RequestCheckpoint", "Restart"}, "after one missed heartbeat: ask the trainer for a checkpoint, then restart from it. A blind restart throws away every hour since the last checkpoint; the calls")
	supervisorExpect(ctx, result, "succeeded", "")
	ctx.Equal(result.Restarts, 1, "one missed heartbeat, one restart")
}

func CheckResumeFrom(ctx *harness.Ctx) {
	supervisorWorld(ctx)
	ctx.GRPC.Fail("Heartbeat", codes.Unavailable, "trainer node rebooting", 2, config.Trainer)
	result := supervisorRun(ctx)
	resumed := []string{}
	for _, call := range supervisorCalls(ctx, "Restart") {
		req, _ := call.Request.(*pb.RestartRequest)
		resumed = append(resumed, req.GetResumeFrom())
	}
	ctx.Equal(resumed, []string{"ckpt-job-7-1", "ckpt-job-7-2"}, "each Restart names the checkpoint RequestCheckpoint just returned, or the run cannot be reproduced; the restarts resumed from")
	supervisorExpect(ctx, result, "succeeded", "")
	ctx.Equal(result.CheckpointIDs, []string{"ckpt-job-7-1", "ckpt-job-7-2"}, "the result must carry the checkpoint lineage in order")
	ctx.Equal(result.Restarts, 2, "two missed heartbeats, two restarts")
}

func CheckCheckpointFailure(ctx *harness.Ctx) {
	supervisorWorld(ctx)
	ctx.GRPC.Fail("Heartbeat", codes.Unavailable, "trainer node rebooting", 1, config.Trainer)
	ctx.GRPC.Fail("RequestCheckpoint", codes.FailedPrecondition, "checkpoint volume full", 1, config.Trainer)
	result := supervisorRun(ctx)
	ctx.Equal(len(supervisorCalls(ctx, "Restart")), 0, "the trainer could not checkpoint and the supervisor restarted it anyway: the run must fail with a reason instead; Restart calls")
	supervisorExpect(ctx, result, "failed", "checkpoint_failed")
	ctx.Equal(len(supervisorCalls(ctx, "Heartbeat")), 1, "a failed run is not watched further; Heartbeat calls")
}

func CheckStopOnRepeated(ctx *harness.Ctx) {
	supervisorWorld(ctx)
	ctx.GRPC.Fail("Heartbeat", codes.Unavailable, "trainer wedged", 10, config.Trainer)
	result := supervisorRun(ctx)
	beats, restarts := len(supervisorCalls(ctx, "Heartbeat")), len(supervisorCalls(ctx, "Restart"))
	ctx.Assert(beats == 3 && restarts == 2, "a heartbeat that keeps failing got %d Heartbeat calls and %d restarts, expected 3 and 2: the third failure (maxHeartbeatFailures) ends the run", beats, restarts)
	supervisorExpect(ctx, result, "failed", "heartbeat_lost")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "finetune/config.h"

namespace {

const std::string kJob = "job-7";

// The stand-in trainer: done on its third answered heartbeat; a restarted run answers promptly.
class TrainerPeer final : public finetuned::Trainer::Service {
 public:
  explicit TrainerPeer(harness::Ctx& ctx) : ctx_(ctx) {}

  grpc::Status Heartbeat(grpc::ServerContext*, const finetuned::HeartbeatRequest* req, finetuned::HeartbeatReply* reply) override {
    const long long n = ++beats_[req->job_id()];
    reply->set_step(n * 100);
    reply->set_done(n >= 3);
    return grpc::Status::OK;
  }

  grpc::Status RequestCheckpoint(grpc::ServerContext*, const finetuned::CheckpointRequest* req, finetuned::CheckpointReply* reply) override {
    const int n = ++checkpoints_[req->job_id()];
    reply->set_checkpoint_id("ckpt-" + req->job_id() + "-" + std::to_string(n));
    return grpc::Status::OK;
  }

  grpc::Status Restart(grpc::ServerContext*, const finetuned::RestartRequest* req, finetuned::RestartReply* reply) override {
    reply->set_attempt(++restarts_[req->job_id()]);
    ctx_.GRPC.SetLatency("Heartbeat", 0, config::kTrainer);
    return grpc::Status::OK;
  }

 private:
  harness::Ctx& ctx_;
  std::map<std::string, long long> beats_;
  std::map<std::string, int> checkpoints_;
  std::map<std::string, int> restarts_;
};

void supervisorWorld(harness::Ctx& ctx) {
  static TrainerPeer* peer = nullptr;
  delete peer;
  peer = new TrainerPeer(ctx);
  ctx.GRPC.Server(config::kTrainer)->RegisterService(peer);
}

void expectRun(harness::Ctx& ctx, const Supervision& result, const std::string& status, const std::string& reason = "") {
  ctx.Equal(result.status, status, "the run's status (reason %q, restarts %d)", result.reason, result.restarts);
  if (!reason.empty()) ctx.Equal(result.reason, reason, "the run's reason");
}

}  // namespace

void CheckHeartbeatDeadline(harness::Ctx& ctx) {
  supervisorWorld(ctx);
  ctx.GRPC.SetLatency("Heartbeat", 45, config::kTrainer);
  const Supervision result = supervise(kJob);
  ctx.Equal(ctx.GRPC.CallsTo("Restart").size(), 0, "a trainer answering heartbeats in 45 s (busy writing a checkpoint shard) was restarted: a deadline under 60 s threw away a healthy run's progress; Restart calls");
  expectRun(ctx, result, "succeeded");
  ctx.Equal(result.restarts, 0, "a healthy run has no restarts");
  const auto beats = ctx.GRPC.CallsTo("Heartbeat");
  ctx.Equal(beats.size(), 3, "the run finishes on its third heartbeat; Heartbeat calls");
  for (const auto& call : beats) {
    ctx.Assert(call.HasDeadline() && call.TimeoutSeconds() >= 55 && call.TimeoutSeconds() <= 65, "every Heartbeat carries a 60 s deadline (kHeartbeatDeadline), one carried %vs", call.TimeoutSeconds());
  }
}

void CheckCheckpointFirst(harness::Ctx& ctx) {
  supervisorWorld(ctx);
  ctx.GRPC.Fail("Heartbeat", grpc::StatusCode::UNAVAILABLE, "trainer node rebooting", 1, config::kTrainer);
  const Supervision result = supervise(kJob);
  std::vector<std::string> order;
  for (const auto& call : ctx.GRPC.Calls()) {
    const std::string name = call.Method.substr(call.Method.rfind('/') + 1);
    if (name == "RequestCheckpoint" || name == "Restart") order.push_back(name);
  }
  ctx.Equal(order, {"RequestCheckpoint", "Restart"}, "after one missed heartbeat: ask the trainer for a checkpoint, then restart from it. A blind restart throws away every hour since the last checkpoint; the calls");
  expectRun(ctx, result, "succeeded");
  ctx.Equal(result.restarts, 1, "one missed heartbeat, one restart");
}

void CheckResumeFrom(harness::Ctx& ctx) {
  supervisorWorld(ctx);
  ctx.GRPC.Fail("Heartbeat", grpc::StatusCode::UNAVAILABLE, "trainer node rebooting", 2, config::kTrainer);
  const Supervision result = supervise(kJob);
  std::vector<std::string> resumed;
  for (const auto& call : ctx.GRPC.CallsTo("Restart")) resumed.push_back(call.Request<finetuned::RestartRequest>().resume_from());
  ctx.Equal(resumed, {"ckpt-job-7-1", "ckpt-job-7-2"}, "each Restart names the checkpoint RequestCheckpoint just returned, or the run cannot be reproduced; the restarts resumed from");
  expectRun(ctx, result, "succeeded");
  ctx.Equal(result.checkpoint_ids, {"ckpt-job-7-1", "ckpt-job-7-2"}, "the result must carry the checkpoint lineage in order");
  ctx.Equal(result.restarts, 2, "two missed heartbeats, two restarts");
}

void CheckCheckpointFailure(harness::Ctx& ctx) {
  supervisorWorld(ctx);
  ctx.GRPC.Fail("Heartbeat", grpc::StatusCode::UNAVAILABLE, "trainer node rebooting", 1, config::kTrainer);
  ctx.GRPC.Fail("RequestCheckpoint", grpc::StatusCode::FAILED_PRECONDITION, "checkpoint volume full", 1, config::kTrainer);
  const Supervision result = supervise(kJob);
  ctx.Equal(ctx.GRPC.CallsTo("Restart").size(), 0, "the trainer could not checkpoint and the supervisor restarted it anyway: the run must fail with a reason instead; Restart calls");
  expectRun(ctx, result, "failed", "checkpoint_failed");
  ctx.Equal(ctx.GRPC.CallsTo("Heartbeat").size(), 1, "a failed run is not watched further; Heartbeat calls");
}

void CheckStopOnRepeated(harness::Ctx& ctx) {
  supervisorWorld(ctx);
  ctx.GRPC.Fail("Heartbeat", grpc::StatusCode::UNAVAILABLE, "trainer wedged", 10, config::kTrainer);
  const Supervision result = supervise(kJob);
  const size_t beats = ctx.GRPC.CallsTo("Heartbeat").size();
  const size_t restarts = ctx.GRPC.CallsTo("Restart").size();
  ctx.Assert(beats == 3 && restarts == 2, "a heartbeat that keeps failing got %d Heartbeat calls and %d restarts, expected 3 and 2: the third failure (kMaxHeartbeatFailures) ends the run", beats, restarts);
  expectRun(ctx, result, "failed", "heartbeat_lost");
}
`,
  },
  hints: [
    'Symptom: a run that answers heartbeats slowly while it writes a checkpoint is restarted from scratch, restarts name no checkpoint, and a trainer with a broken heartbeat is restarted again and again with no failure ever reported.',
    'Mechanism: the heartbeat timeout is 30 s, shorter than a busy trainer\u2019s answer; the except branch goes straight to `Restart` with an empty `resume_from`; nothing counts failures, so the loop only ends when the trainer recovers.',
    'Change: `HEARTBEAT_DEADLINE_S = 60` on every call; on a failure count it, return `heartbeat_lost` at `MAX_HEARTBEAT_FAILURES`, call `RequestCheckpoint`, return `checkpoint_failed` on an error or empty id, append the id and `Restart(resume_from=checkpoint.checkpoint_id)`.',
  ],
  debrief: `The supervisor\u2019s shape follows from treating a missed heartbeat as a question, not a verdict. The deadline is sized to the slowest healthy answer (a trainer flushing a checkpoint shard), because every false positive costs the hours since the last checkpoint. Asking for a checkpoint before acting turns a restart from "start over" into "resume from here", and naming that id on the restart is what lets anyone reproduce the run later. A cap on failures, and an explicit failure when the trainer cannot checkpoint, keep the loop from spending the team\u2019s budget on a run that will not finish. A production supervisor also tells a preempted node from a crashed process by exit code, as Kubeflow\u2019s ExitCode policy does, and backs off between restarts.`,
};
