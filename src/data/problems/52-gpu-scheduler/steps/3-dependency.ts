import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Workload start calls with a health gate',
  concept: 'grpc',
  file: 'client',
  focus: ['scheduler', 'agent', 'fleet'],
  task: `## Task

The starter is a plausible model-generated draft: the happy path places the demo workload, the
agent acknowledges, and the placement looks running. Every failure path is wrong. Find them, fix
them, and prove the fix.

Implement \`start_workload(node_id, workload_id)\` for the scheduler’s node-agent client:

- The \`Start\` call to the node agent is a **gRPC** call with an explicit **20-second** deadline
  (\`START_DEADLINE_S\` / \`START_DEADLINE_MS\` / \`startDeadlineS\` / \`StartDeadlineS\` /
  \`kStartDeadlineS\`) set on the call itself, not the client’s default.
- The placement is marked \`RUNNING\` only after the agent reports **health**
  (\`WaitForHealthy\` / \`waitHealthy\`). An acknowledgement means the request was received, not
  that the workload runs — the draft marks the placement running as soon as the agent
  acknowledges.
- An **image-pull rejection** (\`IMAGE_PULL_FAILED\` / \`ImagePullFailed\`) stops after **one
  node** and returns a clear reason instead of retrying every node in the fleet. The draft’s
  blanket handler walks the fleet.
- A start that exceeds the deadline is **rolled back** and the allocation is **released**
  (\`rollback_placement\` / \`release_allocation\`), so the GPUs return to the pool. The draft
  leaks the allocation: no rollback, no release.
- Retry on another node happens only for **retryable** outcomes (\`DEADLINE_EXCEEDED\` /
  \`UNAVAILABLE\`), classified through \`is_retryable\` and \`RETRYABLE_CODES\`, with the attempt
  counter bounded. The draft retries every error on every node.

**Failure mode the checks target.** The draft’s blanket \`except\`/\`catch\` treats an image-pull
rejection like a transient network error, walks the whole fleet, and leaks the allocation on every
slow start. Marking the placement running on the acknowledgement is the quiet one: a workload that
never becomes healthy looks placed but cannot serve, and the scheduler hands the same node to
another tenant.`,
  sequence: {
    participants: ['Scheduler', 'Node agent', 'Node registry', 'Fleet'],
    messages: [
      {from: 'Scheduler', to: 'Node agent', label: 'Start(node, workload) · deadline=20s', kind: 'sync'},
      {from: 'Node agent', to: 'Scheduler', label: 'acknowledgement', kind: 'reply'},
      {from: 'Scheduler', to: 'Node agent', label: 'WaitForHealthy(node, workload)', kind: 'sync'},
      {from: 'Node agent', to: 'Scheduler', label: 'healthy / IMAGE_PULL_FAILED', kind: 'reply'},
      {from: 'Scheduler', to: 'Node registry', label: 'rollback(node) · release(allocation)', kind: 'sync'},
      {from: 'Scheduler', to: 'Fleet', label: 'retry on another node if retryable', kind: 'async'},
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call changes nothing. Bound the attempts with a constant and a `for` loop: the draft’s blanket `except`/`catch` has no exit for a permanent error like an image-pull rejection.',
    'A placement is running only after the agent reports health. Call `WaitForHealthy`/`waitHealthy` and only then write the `RUNNING` state — the acknowledgement only means the request was received. Use an explicit constant such as `START_DEADLINE_S` so the 20-second bound is visible on the call.',
    'An image-pull rejection is permanent: classify it as non-retryable and return the reason instead of walking the fleet. A deadline that passes is a rollback: release the allocation so the GPUs return to the pool, and only retry the outcomes that are actually retryable.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Start call carries an explicit 20-second deadline',
      detail:
        'The gRPC `Start` call sets a 20-second deadline explicitly (a named constant such as `START_DEADLINE_S`, set on the call), not the client default. The draft’s unary call has no deadline at all.',
      match: {
        python: {all: [/START_DEADLINE_S/, /timeout\s*=\s*START_DEADLINE_S/]},
        typescript: {all: [/START_DEADLINE_MS/, /deadline\s*:\s*Date\.now\(\)\s*\+\s*START_DEADLINE_MS/]},
        go: {all: [/startDeadlineS/, /context\.WithTimeout\([^)]*startDeadlineS/]},
        scala: {all: [/StartDeadlineS/, /withDeadlineAfter\([^)]*StartDeadlineS/]},
        cpp: {all: [/kStartDeadlineS/, /set_deadline\(.*kStartDeadlineS/]},
      },
    },
    {
      id: 'health-gate',
      title: 'Running only after the agent reports healthy',
      detail:
        'The placement is marked `RUNNING` only after the agent reports health (`WaitForHealthy`/`waitHealthy`); the health check precedes the running write. The draft marks it running as soon as the agent acknowledges the start request.',
      match: {
        python: {order: [/wait_healthy|WaitForHealthy|waitHealthy/, /RUNNING/]},
        typescript: {order: [/waitHealthy|WaitForHealthy/, /RUNNING/]},
        go: {order: [/waitHealthy|WaitForHealthy/, /Running/]},
        scala: {order: [/waitHealthy|WaitForHealthy/, /Running/]},
        cpp: {order: [/waitHealthy|WaitForHealthy/, /kRunning/]},
      },
    },
    {
      id: 'image-pull-stop',
      title: 'Image-pull rejection stops after one node with a reason',
      detail:
        'An image-pull rejection (`IMAGE_PULL_FAILED`/`ImagePullFailed`) stops after one node and returns a clear reason instead of retrying the whole fleet. The draft’s blanket handler walks every node.',
      match: {
        python: {all: [/IMAGE_PULL_FAILED/, /return\s+.*reason/]},
        typescript: {all: [/IMAGE_PULL_FAILED/, /return\s+.*reason/]},
        go: {all: [/imagePullFailed/, /return\s+.*imagePullFailed/]},
        scala: {all: [/ImagePullFailed/, /StartResult\("rejected"/]},
        cpp: {all: [/kImagePullFailed/, /return\s+.*kImagePullFailed/]},
      },
    },
    {
      id: 'rollback',
      title: 'Deadline exceeded rolls back and releases the allocation',
      detail:
        'A start that exceeds the deadline is rolled back and the allocation is released (`rollback_placement`/`release_allocation`). The draft leaks the allocation: no rollback, no release.',
      match: {
        python: {all: [/rollback_placement/, /release_allocation/]},
        typescript: {all: [/rollbackPlacement/, /releaseAllocation/]},
        go: {all: [/rollbackPlacement/, /releaseAllocation/]},
        scala: {all: [/rollbackPlacement/, /releaseAllocation/]},
        cpp: {all: [/rollbackPlacement/, /releaseAllocation/]},
      },
    },
    {
      id: 'retry-classification',
      title: 'Retries only retryable outcomes with a bounded attempt counter',
      detail:
        'Retry on another node happens only for retryable outcomes (`DEADLINE_EXCEEDED`/`UNAVAILABLE`), classified through `is_retryable` and `RETRYABLE_CODES`, with the attempt counter bounded. The draft retries every error on every node.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /is_retryable/]},
        typescript: {all: [/RETRYABLE_CODES/, /isRetryable/]},
        go: {all: [/retryableCodes/, /isRetryable/]},
        scala: {all: [/RetryableCodes/, /isRetryable/]},
        cpp: {all: [/kRetryableCodes/, /isRetryable/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc


def start_workload(node_id: str, workload_id: str) -> dict:
    # TODO: add the 20-second deadline, verify health before marking the placement running,
    # stop after an image-pull rejection with a clear reason, and roll back on a deadline.
    request = StartRequest(workload_id=workload_id)
    try:
        stub = agent_stub(node_id)
        stub.Start(request)
        placement.mark_running(workload_id)
        return {"status": "running"}
    except Exception:
        for node in fleet:
            try:
                stub = agent_stub(node)
                stub.Start(request)
                placement.mark_running(workload_id)
                return {"status": "running"}
            except Exception:
                continue
        return {"status": "failed"}
`,
      solution: `import grpc

START_DEADLINE_S = 20.0
IMAGE_PULL_FAILED = "IMAGE_PULL_FAILED"
RETRYABLE_CODES = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE}


def is_retryable(error: grpc.RpcError) -> bool:
    return error.code() in RETRYABLE_CODES


def wait_healthy(node_id: str, workload_id: str) -> None:
    agent_stub(node_id).WaitForHealthy(
        HealthRequest(workload_id=workload_id), timeout=START_DEADLINE_S
    )


RUNNING = "RUNNING"


def rollback_placement(workload_id: str) -> None:
    placement.rollback(workload_id)


def release_allocation(workload_id: str) -> None:
    placement.release(workload_id)


def start_workload(node_id: str, workload_id: str) -> dict:
    request = StartRequest(workload_id=workload_id)
    try:
        stub = agent_stub(node_id)
        stub.Start(request, timeout=START_DEADLINE_S)
        wait_healthy(node_id, workload_id)
        placement.mark(workload_id, RUNNING)
        return {"status": "running"}
    except grpc.RpcError as error:
        if error.code() == grpc.StatusCode.IMAGE_PULL_FAILED:
            reason = IMAGE_PULL_FAILED
            return {"status": "rejected", "reason": reason}
        if not is_retryable(error):
            raise
        rollback_placement(workload_id)
        release_allocation(workload_id)
        return retry_on_another_node(node_id, workload_id)
`,
    },
    typescript: {
      starter: `/** Node-agent start: a model-generated draft that marks running on the acknowledgement. */
import * as grpc from '@grpc/grpc-js';

export async function startWorkload(nodeId: string, workloadId: string): Promise<{status: string}> {
  // TODO: add the 20-second deadline, verify health before marking the placement running,
  // stop after an image-pull rejection with a clear reason, and roll back on a deadline.
  try {
    const stub = agentStub(nodeId);
    await stub.Start({workloadId});
    await placement.markRunning(workloadId);
    return {status: 'running'};
  } catch {
    for (const node of fleet) {
      try {
        const stub = agentStub(node);
        await stub.Start({workloadId});
        await placement.markRunning(workloadId);
        return {status: 'running'};
      } catch {
        continue;
      }
    }
    return {status: 'failed'};
  }
}
`,
      solution: `/** Node-agent start: 20-second deadline, health gate, rollback, and retryable classification. */
import * as grpc from '@grpc/grpc-js';

const START_DEADLINE_MS = 20_000;
const IMAGE_PULL_FAILED = 'IMAGE_PULL_FAILED';
const RETRYABLE_CODES: Record<number, true> = {
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.UNAVAILABLE]: true,
};

function isRetryable(error: grpc.ServiceError): boolean {
  return RETRYABLE_CODES[error.code] === true;
}

async function waitHealthy(nodeId: string, workloadId: string): Promise<void> {
  const stub = agentStub(nodeId);
  await stub.WaitForHealthy({workloadId}, new grpc.Metadata(), {
    deadline: Date.now() + START_DEADLINE_MS,
  });
}

const RUNNING = 'RUNNING';

async function rollbackPlacement(workloadId: string): Promise<void> {
  await placement.rollback(workloadId);
}

async function releaseAllocation(workloadId: string): Promise<void> {
  await placement.release(workloadId);
}

export async function startWorkload(
  nodeId: string,
  workloadId: string,
): Promise<{status: string; reason?: string}> {
  try {
    const stub = agentStub(nodeId);
    await stub.Start({workloadId}, new grpc.Metadata(), {
      deadline: Date.now() + START_DEADLINE_MS,
    });
    await waitHealthy(nodeId, workloadId);
    await placement.mark(workloadId, RUNNING);
    return {status: 'running'};
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    if (serviceError.details.includes(IMAGE_PULL_FAILED)) {
      const reason = IMAGE_PULL_FAILED;
      return {status: 'rejected', reason};
    }
    if (!isRetryable(serviceError)) throw serviceError;
    await rollbackPlacement(workloadId);
    await releaseAllocation(workloadId);
    return retryOnAnotherNode(nodeId, workloadId);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "scheduler/agentpb"
)

func startWorkload(ctx context.Context, nodeID, workloadID string) (string, error) {
	// TODO: add the 20-second deadline, verify health before marking the placement running,
	// stop after an image-pull rejection with a clear reason, and roll back on a deadline.
	request := &pb.StartRequest{WorkloadId: workloadID}
	if _, err := agentStub(nodeID).Start(ctx, request); err == nil {
		_ = placement.Mark(ctx, workloadID, "running")
		return "running", nil
	}
	for _, node := range fleet {
		if _, err := agentStub(node).Start(ctx, request); err == nil {
			_ = placement.Mark(ctx, workloadID, "running")
			return "running", nil
		}
	}
	return "failed", nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "scheduler/agentpb"
)

const (
	startDeadlineS  = 20
	imagePullFailed = "IMAGE_PULL_FAILED"
)

var retryableCodes = map[codes.Code]bool{
	codes.DeadlineExceeded: true,
	codes.Unavailable:      true,
}

func isRetryable(err error) bool {
	st, ok := status.FromError(err)
	return ok && retryableCodes[st.Code()]
}

func waitHealthy(ctx context.Context, nodeID, workloadID string) error {
	callCtx, cancel := context.WithTimeout(ctx, startDeadlineS*time.Second)
	defer cancel()
	_, err := agentStub(nodeID).WaitForHealthy(callCtx, &pb.HealthRequest{WorkloadId: workloadID})
	return err
}

const Running = "RUNNING"

func rollbackPlacement(ctx context.Context, workloadID string) error {
	return placement.Rollback(ctx, workloadID)
}

func releaseAllocation(ctx context.Context, workloadID string) error {
	return placement.Release(ctx, workloadID)
}

func startWorkload(ctx context.Context, nodeID, workloadID string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, startDeadlineS*time.Second)
	defer cancel()
	request := &pb.StartRequest{WorkloadId: workloadID}
	if _, err := agentStub(nodeID).Start(callCtx, request); err != nil {
		if status.Convert(err).Message() == imagePullFailed {
			return "", errors.New(imagePullFailed)
		}
		if !isRetryable(err) {
			return "", err
		}
		_ = rollbackPlacement(ctx, workloadID)
		_ = releaseAllocation(ctx, workloadID)
		return retryOnAnotherNode(ctx, nodeID, workloadID)
	}
	if err := waitHealthy(callCtx, nodeID, workloadID); err != nil {
		return "", err
	}
	_ = placement.Mark(ctx, workloadID, Running)
	return "running", nil
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object Dependency {
  def startWorkload(nodeId: String, workloadId: String): String = {
    // TODO: add the 20-second deadline, verify health before marking the placement running,
    // stop after an image-pull rejection with a clear reason, and roll back on a deadline.
    val request = StartRequest(workloadId = workloadId)
    try {
      agentStub(nodeId).start(request)
      placement.markRunning(workloadId)
      "running"
    } catch {
      case _: StatusRuntimeException =>
        fleet.foreach { node =>
          try {
            agentStub(node).start(request)
            placement.markRunning(workloadId)
            return "running"
          } catch {
            case _: StatusRuntimeException => ()
          }
        }
        "failed"
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object Dependency {
  val StartDeadlineS = 20
  val ImagePullFailed = "IMAGE_PULL_FAILED"
  val RetryableCodes = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)

  case class StartResult(status: String, reason: String)

  def isRetryable(exc: StatusRuntimeException): Boolean =
    RetryableCodes.contains(exc.getStatus.getCode)

  def waitHealthy(nodeId: String, workloadId: String): Unit =
    agentStub(nodeId)
      .withDeadlineAfter(StartDeadlineS, TimeUnit.SECONDS)
      .waitForHealthy(HealthRequest(workloadId = workloadId))

  val Running = "RUNNING"

  def rollbackPlacement(workloadId: String): Unit = placement.rollback(workloadId)

  def releaseAllocation(workloadId: String): Unit = placement.release(workloadId)

  def startWorkload(nodeId: String, workloadId: String): String = {
    val request = StartRequest(workloadId = workloadId)
    try {
      agentStub(nodeId).withDeadlineAfter(StartDeadlineS, TimeUnit.SECONDS).start(request)
      waitHealthy(nodeId, workloadId)
      placement.mark(workloadId, Running)
      "running"
    } catch {
      case exc: StatusRuntimeException if exc.getStatus.getDescription == ImagePullFailed =>
        StartResult("rejected", ImagePullFailed).toString
      case exc: StatusRuntimeException if !isRetryable(exc) =>
        throw exc
      case _: StatusRuntimeException =>
        rollbackPlacement(workloadId)
        releaseAllocation(workloadId)
        retryOnAnotherNode(nodeId, workloadId)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "agent.grpc.pb.h"

#include <string>

std::string startWorkload(Agent::Stub* agent, const std::string& node_id, const std::string& workload_id) {
  // TODO: add the 20-second deadline, verify health before marking the placement running,
  // stop after an image-pull rejection with a clear reason, and roll back on a deadline.
  StartRequest request;
  request.set_workload_id(workload_id);
  grpc::ClientContext ctx;
  StartReply reply;
  if (agent->Start(&ctx, request, &reply).ok()) {
    placement.mark_running(workload_id);
    return "running";
  }
  for (const auto& node : fleet) {
    grpc::ClientContext node_ctx;
    StartReply node_reply;
    if (agent->Start(&node_ctx, request, &node_reply).ok()) {
      placement.mark_running(workload_id);
      return "running";
    }
  }
  return "failed";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "agent.grpc.pb.h"

#include <chrono>
#include <string>

constexpr int kStartDeadlineS = 20;
constexpr char kImagePullFailed[] = "IMAGE_PULL_FAILED";
constexpr grpc::StatusCode kRetryableCodes[] = {grpc::StatusCode::DEADLINE_EXCEEDED,
                                                grpc::StatusCode::UNAVAILABLE};

bool isRetryable(const grpc::Status& status) {
  for (const auto code : kRetryableCodes) {
    if (status.error_code() == code) return true;
  }
  return false;
}

void waitHealthy(Agent::Stub* agent, const std::string& workload_id) {
  HealthRequest request;
  request.set_workload_id(workload_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kStartDeadlineS));
  HealthReply reply;
  agent->WaitForHealthy(&ctx, request, &reply);
}

constexpr char kRunning[] = "RUNNING";

void rollbackPlacement(const std::string& workload_id) { placement.rollback(workload_id); }

void releaseAllocation(const std::string& workload_id) { placement.release(workload_id); }

std::string startWorkload(Agent::Stub* agent, const std::string& node_id, const std::string& workload_id) {
  StartRequest request;
  request.set_workload_id(workload_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kStartDeadlineS));
  StartReply reply;
  const grpc::Status status = agent->Start(&ctx, request, &reply);
  if (!status.ok()) {
    if (status.error_message() == kImagePullFailed) {
      return kImagePullFailed;
    }
    if (!isRetryable(status)) {
      return status.error_message();
    }
    rollbackPlacement(workload_id);
    releaseAllocation(workload_id);
    return retryOnAnotherNode(node_id, workload_id);
  }
  waitHealthy(agent, workload_id);
  placement.mark(workload_id, kRunning);
  return "running";
}
`,
    },
  },
  debrief: `The reviewer is testing whether you can tell a placement that is *running* from one that
merely exists. The acknowledgement is not a health report: a workload image can pull, start, and
crash before the first health probe, so the running write must be gated on \`WaitForHealthy\`, not
on the \`Start\` reply. The deadline is the bound on the gate: a 20-second start that never reports
health must be rolled back and the allocation released, or the GPUs stay reserved for a workload
that will never run and the scheduler refuses a tenant that could have used them. The image-pull
rejection is the classification half: a permanent failure must stop after one node with a reason,
not walk the fleet turning a bad image into a fleet-wide outage. The draft looks fine because the
demo image pulls and the first node answers. Real schedulers add rolling retries with jittered
backoff across a bounded node set, per-node health caches, and a reconciliation loop that releases
allocations for placements that have no running workload.`,
};
