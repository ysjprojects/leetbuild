import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Start the workload: a deadline, a health gate, a rollback',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['scheduler', 'agent', 'redis'],
  task: `## Task

**Starting point.** The starter's \`start_placement(placement_id, image, count, nodes)\` walks the
candidate nodes: it books one through \`allocate\`, calls the node agent's \`Start\` at
\`{node}:50051\`, marks the placement \`running\` and returns the node; a failed \`Start\` moves on
to the next node. It runs the demo workload and hides five flaws.

**Failure mode the checks target.** An agent that stalls holds the scheduler for as long as it
likes; a container that never comes up, or dies at once, is reported as running; an image that
cannot be pulled is tried on every node of the fleet; every failed node keeps its booking; an
argument error is retried like an outage.

\`\`\`proto
service NodeAgent { rpc Start(StartRequest) returns (StartReply); rpc Health(HealthRequest) returns (HealthReply); }
enum HealthStatus { STARTING = 0; HEALTHY = 1; FAILED = 2; }
\`\`\`

- Each node gets a budget of \`START_DEADLINE_S\` (20 s): the \`Start\` call carries that deadline
  and \`Health\` is polled every \`HEALTH_POLL_S\` until \`HEALTHY\`, \`FAILED\` or the budget is spent.
- \`HEALTHY\` sets \`placement:{pid}\` \`status\` to \`running\` and returns
  \`{"status": "running", "node_id"}\`; nothing is marked running before that.
- Every other outcome calls \`release(node_id, placement_id)\` first. \`FAILED\` (an image that cannot
  be pulled, a container that exited) returns \`{"status": "failed", "reason"}\` with the agent's
  reason and tries no other node. \`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\` and a spent budget are
  retryable: try the next node, at most \`MAX_START_ATTEMPTS\` starts in all. Any other status
  fails without a retry.`,
  sequence: {
    participants: ['gpusched', 'Redis', 'Node agent'],
    messages: [
      {from: 'gpusched', to: 'Redis', label: 'EVAL allocate gpu-1 p-7 4 → ALLOCATED', kind: 'sync'},
      {from: 'gpusched', to: 'Node agent', label: 'Start{p-7, registry/infer:1, 4} · deadline 20 s', kind: 'sync'},
      {from: 'Node agent', to: 'gpusched', label: 'StartReply{c-7}', kind: 'reply'},
      {from: 'gpusched', to: 'Node agent', label: 'Health{p-7} · every 1 s', kind: 'sync'},
      {from: 'Node agent', to: 'gpusched', label: 'STARTING … HEALTHY', kind: 'reply'},
      {from: 'gpusched', to: 'Redis', label: 'HSET placement:p-7 status running', kind: 'sync'},
      {
        from: 'gpusched',
        to: 'Node agent',
        label: 'Start{p-8, registry/missing:9} → Health FAILED "image pull failed"',
        kind: 'sync',
      },
      {from: 'gpusched', to: 'Redis', label: 'EVAL release gpu-1 p-8 · no other node is tried', kind: 'sync'},
    ],
  },
  hints: [
    'A placement reads `running` while its container is still pulling; a job whose image does not exist is started on every node in turn; `allocated` on the nodes it failed on stays booked.',
    'The starter trusts the `Start` acknowledgement as proof the workload runs, carries no deadline, treats every error as "try the next node" and has no path that releases a booking.',
    'Put the deadline on the `Start` call, poll `Health` under the same budget, write `running` only on `HEALTHY`, `release` before every other return, and retry only on `DEADLINE_EXCEEDED`, `UNAVAILABLE` and a spent budget, counting attempts.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Start carries the 20-second deadline',
      detail:
        'The `Start` call sets a deadline of `START_DEADLINE_S` (20 s). An agent slower than that answers `DEADLINE_EXCEEDED`, which is retryable; the starter has no deadline and waits as long as the agent takes.',
      match: {
        python: {all: [/stub\.Start\([\s\S]{0,200}?timeout\s*=/, /START_DEADLINE_S/]},
        typescript: {all: [/\.Start\([\s\S]{0,200}?deadline/, /START_DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\([^\n]*config\.StartDeadline/, /\.Start\(/]},
        scala: {all: [/withDeadlineAfter\(\s*StartDeadlineMillis/, /\.start\(/]},
        cpp: {all: [/set_deadline\(/, /kStartDeadline/, /->Start\(/]},
      },
    },
    {
      id: 'health-gate',
      title: 'running only after the agent reports HEALTHY',
      detail:
        '`Health` is polled after `Start` and the placement is marked `running` only on `HEALTHY`; a `FAILED` report ends the start. The starter writes `running` as soon as `Start` is acknowledged.',
      match: {
        python: {all: [/stub\.Health\(/, /HEALTHY/, /FAILED/], order: [/stub\.Health\(/, /["']running["']/]},
        typescript: {
          all: [/\.Health\(/, /['"]HEALTHY['"]/, /['"]FAILED['"]/],
          order: [/\.Health\(/, /['"]running['"]/],
        },
        go: {
          all: [/\.Health\(/, /pb\.HealthStatus_HEALTHY/, /pb\.HealthStatus_FAILED/],
          order: [/\.Health\(/, /"running"/],
        },
        scala: {
          all: [/\.health\(/, /HealthStatus\.HEALTHY/, /HealthStatus\.FAILED/],
          order: [/\.health\(/, /"running"/],
        },
        cpp: {all: [/->Health\(/, /gpusched::HEALTHY/, /gpusched::FAILED/], order: [/->Health\(/, /"running"/]},
      },
    },
    {
      id: 'image-pull-stop',
      title: 'FAILED stops after one node with the agent’s reason',
      detail:
        'A `FAILED` health report (an image that cannot be pulled, a container that exited) is returned as `failed` with the agent’s `reason` and no other node is tried. The starter never asks for health, so a bad image is started everywhere.',
      match: {
        python: {
          all: [/health\.reason|\.reason\b/, /["']failed["']/],
          none: [/except grpc\.RpcError[^\n]*:\s*\n\s*continue/],
        },
        typescript: {all: [/health\.reason|\.reason\b/, /['"]failed['"]/]},
        go: {all: [/health\.GetReason\(\)|\.Reason\b/, /"failed"/]},
        scala: {all: [/health\.reason|\.reason\b/, /"failed"/]},
        cpp: {all: [/health\.reason\(\)|\.reason\(\)/, /"failed"/]},
      },
    },
    {
      id: 'rollback',
      title: 'Every failed start releases its booking',
      detail:
        'Before any return other than `running`, `release(node_id, placement_id)` returns the GPUs. The starter never releases, so a node that timed out or refused keeps the booking.',
      match: {
        python: {all: [/\brelease\(/], order: [/stub\.Start\(/, /\brelease\(/]},
        typescript: {all: [/\brelease\(/], order: [/\.Start\(/, /\brelease\(/]},
        go: {all: [/\brelease\(/], order: [/\.Start\(/, /\brelease\(/]},
        scala: {all: [/State\.release\(/], order: [/\.start\(/, /State\.release\(/]},
        cpp: {all: [/\brelease\(/], order: [/->Start\(/, /\brelease\(/]},
      },
    },
    {
      id: 'retry-classification',
      title: 'Only retryable outcomes move to another node, at most three starts',
      detail:
        '`DEADLINE_EXCEEDED`, `UNAVAILABLE` and a spent budget are retried on the next node, counted against `MAX_START_ATTEMPTS`; any other status fails at once. The starter retries every error on every node.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/, /MAX_START_ATTEMPTS/]},
        typescript: {all: [/RETRYABLE_CODES/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/, /MAX_START_ATTEMPTS/]},
        go: {all: [/retryableCodes/, /codes\.DeadlineExceeded/, /codes\.Unavailable/, /config\.MaxStartAttempts/]},
        scala: {all: [/RetryableCodes/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/, /MaxStartAttempts/]},
        cpp: {all: [/kRetryableCodes|retryable\(/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/, /kMaxStartAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis

import agent_pb2
import agent_pb2_grpc
from gpusched.config import HEALTH_POLL_S, MAX_START_ATTEMPTS, START_DEADLINE_S, agent_target
from state import allocate, release

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.


def _stub(node_id: str) -> agent_pb2_grpc.NodeAgentStub:
    return agent_pb2_grpc.NodeAgentStub(grpc.insecure_channel(agent_target(node_id)))


def start_placement(placement_id: str, image: str, count: int, nodes: list[str]) -> dict:
    """Book a node and start the workload on it: {"status": "running", "node_id"} or {"status": "failed", "reason"}."""
    for node_id in nodes:
        if allocate(node_id, placement_id, count) != "ALLOCATED":
            continue
        try:
            _stub(node_id).Start(agent_pb2.StartRequest(placement_id=placement_id, image=image, gpu_count=count))
        except grpc.RpcError:
            continue
        r.hset(f"placement:{placement_id}", "status", "running")
        return {"status": "running", "node_id": node_id}
    return {"status": "failed", "reason": "no node started the workload"}
`,
      solution: `import time

import grpc
import redis

import agent_pb2
import agent_pb2_grpc
from gpusched.config import HEALTH_POLL_S, MAX_START_ATTEMPTS, START_DEADLINE_S, agent_target
from state import allocate, release

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RETRYABLE_CODES = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE}


def _stub(node_id: str) -> agent_pb2_grpc.NodeAgentStub:
    return agent_pb2_grpc.NodeAgentStub(grpc.insecure_channel(agent_target(node_id)))


def _start_on(node_id: str, placement_id: str, image: str, count: int) -> dict:
    """One node's attempt under one budget: running, or failed with a reason and whether another node may be tried."""
    stub = _stub(node_id)
    deadline = time.monotonic() + START_DEADLINE_S
    try:
        stub.Start(agent_pb2.StartRequest(placement_id=placement_id, image=image, gpu_count=count), timeout=START_DEADLINE_S)
        while time.monotonic() < deadline:
            health = stub.Health(agent_pb2.HealthRequest(placement_id=placement_id), timeout=max(deadline - time.monotonic(), 0.01))
            if health.status == agent_pb2.HEALTHY:
                return {"status": "running"}
            if health.status == agent_pb2.FAILED:
                return {"status": "failed", "reason": health.reason, "retryable": False}
            time.sleep(HEALTH_POLL_S)
    except grpc.RpcError as e:
        return {"status": "failed", "reason": f"agent {e.code().name}: {e.details()}", "retryable": e.code() in RETRYABLE_CODES}
    return {"status": "failed", "reason": "no health report within the deadline", "retryable": True}


def start_placement(placement_id: str, image: str, count: int, nodes: list[str]) -> dict:
    """Book a node and start the workload on it: {"status": "running", "node_id"} or {"status": "failed", "reason"}."""
    attempts = 0
    for node_id in nodes:
        if attempts >= MAX_START_ATTEMPTS:
            break
        if allocate(node_id, placement_id, count) != "ALLOCATED":
            continue
        attempts += 1
        outcome = _start_on(node_id, placement_id, image, count)
        if outcome["status"] == "running":
            r.hset(f"placement:{placement_id}", "status", "running")
            return {"status": "running", "node_id": node_id}
        release(node_id, placement_id)
        if not outcome["retryable"]:
            return {"status": "failed", "reason": outcome["reason"]}
    return {"status": "failed", "reason": "no node started the workload"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {HEALTH_POLL_MS, MAX_START_ATTEMPTS, START_DEADLINE_MS, agentTarget} from 'gpusched/config';
import {allocate, release} from './state';

const redis = new Redis({host: 'redis', port: 6379});

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

interface HealthReply {
  status: 'STARTING' | 'HEALTHY' | 'FAILED';
  reason: string;
}

interface Agent extends grpc.Client {
  Start(request: {placement_id: string; image: string; gpu_count: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{container_id: string}>;
  Health(request: {placement_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<HealthReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('agent.proto')) as unknown as {
  gpusched: {NodeAgent: grpc.ServiceClientConstructor};
};

const stub = (nodeId: string): Agent => new pkg.gpusched.NodeAgent(agentTarget(nodeId), grpc.credentials.createInsecure()) as Agent;

export interface Outcome {
  status: 'running' | 'failed';
  node_id?: string;
  reason?: string;
}

/** Book a node and start the workload on it. */
export async function startPlacement(placementId: string, image: string, count: number, nodes: string[]): Promise<Outcome> {
  for (const nodeId of nodes) {
    if ((await allocate(nodeId, placementId, count)) !== 'ALLOCATED') continue;
    try {
      await stub(nodeId).Start({placement_id: placementId, image, gpu_count: count}, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    await redis.hset(\`placement:\${placementId}\`, 'status', 'running');
    return {status: 'running', node_id: nodeId};
  }
  return {status: 'failed', reason: 'no node started the workload'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {HEALTH_POLL_MS, MAX_START_ATTEMPTS, START_DEADLINE_MS, agentTarget} from 'gpusched/config';
import {allocate, release} from './state';

const redis = new Redis({host: 'redis', port: 6379});

interface HealthReply {
  status: 'STARTING' | 'HEALTHY' | 'FAILED';
  reason: string;
}

interface Agent extends grpc.Client {
  Start(request: {placement_id: string; image: string; gpu_count: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{container_id: string}>;
  Health(request: {placement_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<HealthReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('agent.proto')) as unknown as {
  gpusched: {NodeAgent: grpc.ServiceClientConstructor};
};

const stub = (nodeId: string): Agent => new pkg.gpusched.NodeAgent(agentTarget(nodeId), grpc.credentials.createInsecure()) as Agent;

const RETRYABLE_CODES: Partial<Record<grpc.status, true>> = {[grpc.status.DEADLINE_EXCEEDED]: true, [grpc.status.UNAVAILABLE]: true};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export interface Outcome {
  status: 'running' | 'failed';
  node_id?: string;
  reason?: string;
}

interface Attempt {
  status: 'running' | 'failed';
  reason?: string;
  retryable?: boolean;
}

/** One node's attempt under one budget: running, or failed with a reason and whether another node may be tried. */
async function startOn(nodeId: string, placementId: string, image: string, count: number): Promise<Attempt> {
  const agent = stub(nodeId);
  const deadline = Date.now() + START_DEADLINE_MS;
  try {
    await agent.Start({placement_id: placementId, image, gpu_count: count}, new grpc.Metadata(), {deadline});
    while (Date.now() < deadline) {
      const health = await agent.Health({placement_id: placementId}, new grpc.Metadata(), {deadline});
      if (health.status === 'HEALTHY') return {status: 'running'};
      if (health.status === 'FAILED') return {status: 'failed', reason: health.reason, retryable: false};
      await sleep(HEALTH_POLL_MS);
    }
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    return {status: 'failed', reason: \`agent \${grpc.status[code]}: \${details}\`, retryable: RETRYABLE_CODES[code] === true};
  }
  return {status: 'failed', reason: 'no health report within the deadline', retryable: true};
}

/** Book a node and start the workload on it. */
export async function startPlacement(placementId: string, image: string, count: number, nodes: string[]): Promise<Outcome> {
  let attempts = 0;
  for (const nodeId of nodes) {
    if (attempts >= MAX_START_ATTEMPTS) break;
    if ((await allocate(nodeId, placementId, count)) !== 'ALLOCATED') continue;
    attempts += 1;
    const outcome = await startOn(nodeId, placementId, image, count);
    if (outcome.status === 'running') {
      await redis.hset(\`placement:\${placementId}\`, 'status', 'running');
      return {status: 'running', node_id: nodeId};
    }
    await release(nodeId, placementId);
    if (!outcome.retryable) return {status: 'failed', reason: outcome.reason};
  }
  return {status: 'failed', reason: 'no node started the workload'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"gpusched/config"
	pb "gpusched/gen/agent"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The ledger (state.go, step 2): allocate books count GPUs of the node for the placement, release returns them.
var (
	allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }
	release  = func(ctx context.Context, nodeID, placementID string) (bool, error) { panic("not implemented") }
)

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

// Outcome is what startPlacement reports: running on a node, or failed with a reason.
type Outcome struct {
	Status string \`json:"status"\`
	NodeID string \`json:"node_id,omitempty"\`
	Reason string \`json:"reason,omitempty"\`
}

func agent(nodeID string) (pb.NodeAgentClient, error) {
	conn, err := grpc.NewClient(config.AgentTarget(nodeID), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return pb.NewNodeAgentClient(conn), nil
}

// startPlacement books a node and starts the workload on it.
func startPlacement(ctx context.Context, placementID, image string, count int, nodes []string) Outcome {
	for _, nodeID := range nodes {
		result, err := allocate(ctx, nodeID, placementID, count)
		if err != nil || result != "ALLOCATED" {
			continue
		}
		client, err := agent(nodeID)
		if err != nil {
			continue
		}
		if _, err := client.Start(ctx, &pb.StartRequest{PlacementId: placementID, Image: image, GpuCount: int32(count)}); err != nil {
			continue
		}
		rdb.HSet(ctx, "placement:"+placementID, "status", "running")
		return Outcome{Status: "running", NodeID: nodeID}
	}
	return Outcome{Status: "failed", Reason: "no node started the workload"}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"gpusched/config"
	pb "gpusched/gen/agent"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// The ledger (state.go, step 2): allocate books count GPUs of the node for the placement, release returns them.
var (
	allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }
	release  = func(ctx context.Context, nodeID, placementID string) (bool, error) { panic("not implemented") }
)

var retryableCodes = map[codes.Code]bool{codes.DeadlineExceeded: true, codes.Unavailable: true}

// Outcome is what startPlacement reports: running on a node, or failed with a reason.
type Outcome struct {
	Status string \`json:"status"\`
	NodeID string \`json:"node_id,omitempty"\`
	Reason string \`json:"reason,omitempty"\`
}

// attempt is one node's outcome: running, or failed with a reason and whether another node may be tried.
type attempt struct {
	running   bool
	reason    string
	retryable bool
}

func agent(nodeID string) (pb.NodeAgentClient, error) {
	conn, err := grpc.NewClient(config.AgentTarget(nodeID), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return pb.NewNodeAgentClient(conn), nil
}

// startOn is one node's attempt under one budget.
func startOn(ctx context.Context, nodeID, placementID, image string, count int) attempt {
	client, err := agent(nodeID)
	if err != nil {
		return attempt{reason: err.Error(), retryable: true}
	}
	ctx, cancel := context.WithTimeout(ctx, config.StartDeadline)
	defer cancel()
	rpcFailed := func(err error) attempt {
		return attempt{reason: fmt.Sprintf("agent %s: %s", status.Code(err), status.Convert(err).Message()), retryable: retryableCodes[status.Code(err)]}
	}
	if _, err := client.Start(ctx, &pb.StartRequest{PlacementId: placementID, Image: image, GpuCount: int32(count)}); err != nil {
		return rpcFailed(err)
	}
	for ctx.Err() == nil {
		health, err := client.Health(ctx, &pb.HealthRequest{PlacementId: placementID})
		if err != nil {
			return rpcFailed(err)
		}
		switch health.GetStatus() {
		case pb.HealthStatus_HEALTHY:
			return attempt{running: true}
		case pb.HealthStatus_FAILED:
			return attempt{reason: health.GetReason()}
		}
		time.Sleep(config.HealthPoll)
	}
	return attempt{reason: "no health report within the deadline", retryable: true}
}

// startPlacement books a node and starts the workload on it.
func startPlacement(ctx context.Context, placementID, image string, count int, nodes []string) Outcome {
	attempts := 0
	for _, nodeID := range nodes {
		if attempts >= config.MaxStartAttempts {
			break
		}
		result, err := allocate(ctx, nodeID, placementID, count)
		if err != nil || result != "ALLOCATED" {
			continue
		}
		attempts++
		outcome := startOn(ctx, nodeID, placementID, image, count)
		if outcome.running {
			rdb.HSet(ctx, "placement:"+placementID, "status", "running")
			return Outcome{Status: "running", NodeID: nodeID}
		}
		release(ctx, nodeID, placementID)
		if !outcome.retryable {
			return Outcome{Status: "failed", Reason: outcome.reason}
		}
	}
	return Outcome{Status: "failed", Reason: "no node started the workload"}
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import gpusched.agent.{HealthRequest, HealthStatus, NodeAgentGrpc, StartRequest}

import gpusched.Config.{agentTarget, HealthPollMillis, MaxStartAttempts, StartDeadlineMillis}

object Client {
  val jedis = new JedisPooled("redis", 6379)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

  /** What startPlacement reports: running on a node, or failed with a reason. */
  final case class Outcome(status: String, nodeId: Option[String] = None, reason: Option[String] = None)

  private def stub(nodeId: String): NodeAgentGrpc.NodeAgentBlockingStub = {
    val (host, port) = agentTarget(nodeId).split(":") match { case Array(h, p) => (h, p.toInt) }
    NodeAgentGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port).usePlaintext().build())
  }

  /** Book a node and start the workload on it. */
  def startPlacement(placementId: String, image: String, count: Int, nodes: List[String]): Outcome = {
    for (nodeId <- nodes if State.allocate(nodeId, placementId, count) == "ALLOCATED") {
      try {
        stub(nodeId).start(StartRequest(placementId = placementId, image = image, gpuCount = count))
        jedis.hset(s"placement:$placementId", "status", "running")
        return Outcome("running", nodeId = Some(nodeId))
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    Outcome("failed", reason = Some("no node started the workload"))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import gpusched.agent.{HealthRequest, HealthStatus, NodeAgentGrpc, StartRequest}

import gpusched.Config.{agentTarget, HealthPollMillis, MaxStartAttempts, StartDeadlineMillis}

object Client {
  val jedis = new JedisPooled("redis", 6379)

  val RetryableCodes: Set[Status.Code] = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)

  /** What startPlacement reports: running on a node, or failed with a reason. */
  final case class Outcome(status: String, nodeId: Option[String] = None, reason: Option[String] = None)

  /** One node's attempt: running, or failed with a reason and whether another node may be tried. */
  private final case class Attempt(running: Boolean, reason: String = "", retryable: Boolean = false)

  private def stub(nodeId: String): NodeAgentGrpc.NodeAgentBlockingStub = {
    val (host, port) = agentTarget(nodeId).split(":") match { case Array(h, p) => (h, p.toInt) }
    NodeAgentGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port).usePlaintext().build())
  }

  /** One node's attempt under one budget. */
  private def startOn(nodeId: String, placementId: String, image: String, count: Int): Attempt = {
    val deadline = System.currentTimeMillis() + StartDeadlineMillis
    val agent = stub(nodeId).withDeadlineAfter(StartDeadlineMillis, TimeUnit.MILLISECONDS)
    try {
      agent.start(StartRequest(placementId = placementId, image = image, gpuCount = count))
      while (System.currentTimeMillis() < deadline) {
        val health = agent.health(HealthRequest(placementId = placementId))
        if (health.status == HealthStatus.HEALTHY) return Attempt(running = true)
        if (health.status == HealthStatus.FAILED) return Attempt(running = false, reason = health.reason)
        Thread.sleep(HealthPollMillis)
      }
      Attempt(running = false, reason = "no health report within the deadline", retryable = true)
    } catch {
      case e: StatusRuntimeException =>
        val code = e.getStatus.getCode
        Attempt(running = false, reason = s"agent $code: \${e.getStatus.getDescription}", retryable = RetryableCodes.contains(code))
    }
  }

  /** Book a node and start the workload on it. */
  def startPlacement(placementId: String, image: String, count: Int, nodes: List[String]): Outcome = {
    var attempts = 0
    for (nodeId <- nodes if attempts < MaxStartAttempts && State.allocate(nodeId, placementId, count) == "ALLOCATED") {
      attempts += 1
      val outcome = startOn(nodeId, placementId, image, count)
      if (outcome.running) {
        jedis.hset(s"placement:$placementId", "status", "running")
        return Outcome("running", nodeId = Some(nodeId))
      }
      State.release(nodeId, placementId)
      if (!outcome.retryable) return Outcome("failed", reason = Some(outcome.reason))
    }
    Outcome("failed", reason = Some("no node started the workload"))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "agent.grpc.pb.h"
#include "gpusched/config.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.

// What start_placement reports: running on a node, or failed with a reason.
struct Outcome {
  std::string status;
  std::string node_id;
  std::string reason;
};

std::unique_ptr<gpusched::NodeAgent::Stub> agent(const std::string& node_id) {
  return gpusched::NodeAgent::NewStub(grpc::CreateChannel(gpusched::agent_target(node_id), grpc::InsecureChannelCredentials()));
}

// Books a node and starts the workload on it.
Outcome start_placement(const std::string& placement_id, const std::string& image, int count, const std::vector<std::string>& nodes) {
  for (const std::string& node_id : nodes) {
    if (allocate(node_id, placement_id, count) != "ALLOCATED") continue;
    grpc::ClientContext ctx;
    gpusched::StartRequest request;
    request.set_placement_id(placement_id);
    request.set_image(image);
    request.set_gpu_count(count);
    gpusched::StartReply reply;
    if (!agent(node_id)->Start(&ctx, request, &reply).ok()) continue;
    redis.hset("placement:" + placement_id, "status", "running");
    return {"running", node_id, ""};
  }
  return {"failed", "", "no node started the workload"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "agent.grpc.pb.h"
#include "gpusched/config.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

// What start_placement reports: running on a node, or failed with a reason.
struct Outcome {
  std::string status;
  std::string node_id;
  std::string reason;
};

// One node's attempt: running, or failed with a reason and whether another node may be tried.
struct Attempt {
  bool running = false;
  std::string reason;
  bool retryable = false;
};

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

std::unique_ptr<gpusched::NodeAgent::Stub> agent(const std::string& node_id) {
  return gpusched::NodeAgent::NewStub(grpc::CreateChannel(gpusched::agent_target(node_id), grpc::InsecureChannelCredentials()));
}

Attempt rpc_failed(const grpc::Status& status) {
  return {false, "agent " + std::to_string(status.error_code()) + ": " + status.error_message(), retryable(status.error_code())};
}

// One node's attempt under one budget.
Attempt start_on(const std::string& node_id, const std::string& placement_id, const std::string& image, int count) {
  auto stub = agent(node_id);
  const auto deadline = std::chrono::system_clock::now() + gpusched::kStartDeadline;
  grpc::ClientContext start_ctx;
  start_ctx.set_deadline(deadline);
  gpusched::StartRequest request;
  request.set_placement_id(placement_id);
  request.set_image(image);
  request.set_gpu_count(count);
  gpusched::StartReply reply;
  const grpc::Status started = stub->Start(&start_ctx, request, &reply);
  if (!started.ok()) return rpc_failed(started);
  while (std::chrono::system_clock::now() < deadline) {
    grpc::ClientContext health_ctx;
    health_ctx.set_deadline(deadline);
    gpusched::HealthRequest probe;
    probe.set_placement_id(placement_id);
    gpusched::HealthReply health;
    const grpc::Status polled = stub->Health(&health_ctx, probe, &health);
    if (!polled.ok()) return rpc_failed(polled);
    if (health.status() == gpusched::HEALTHY) return {true, "", false};
    if (health.status() == gpusched::FAILED) return {false, health.reason(), false};
    std::this_thread::sleep_for(gpusched::kHealthPoll);
  }
  return {false, "no health report within the deadline", true};
}

// Books a node and starts the workload on it.
Outcome start_placement(const std::string& placement_id, const std::string& image, int count, const std::vector<std::string>& nodes) {
  int attempts = 0;
  for (const std::string& node_id : nodes) {
    if (attempts >= gpusched::kMaxStartAttempts) break;
    if (allocate(node_id, placement_id, count) != "ALLOCATED") continue;
    attempts++;
    const Attempt outcome = start_on(node_id, placement_id, image, count);
    if (outcome.running) {
      redis.hset("placement:" + placement_id, "status", "running");
      return {"running", node_id, ""};
    }
    release(node_id, placement_id);
    if (!outcome.retryable) return {"failed", "", outcome.reason};
  }
  return {"failed", "", "no node started the workload"};
}
`,
    },
  },
  harness: {
    python: `import grpc

import agent_pb2
import agent_pb2_grpc

INFER = "registry/infer:1"
MISSING = "registry/missing:9"
CRASH = "registry/crash:1"
HANG = "registry/hang:1"


class FakeAgent(agent_pb2_grpc.NodeAgentServicer):
    """The node agent: the image decides what Health reports (the hang image wedges the first node it is started on). The placement's status at the first poll is remembered."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.images = {}
        self.polls = {}
        self.status_at_first_poll = {}
        self.starts = {}

    def Start(self, request, context):
        self.images[request.placement_id] = request.image
        self.polls[request.placement_id] = 0
        self.starts[request.placement_id] = self.starts.get(request.placement_id, 0) + 1
        return agent_pb2.StartReply(container_id=f"c-{request.placement_id}")

    def Health(self, request, context):
        pid = request.placement_id
        if pid not in self.images:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no placement {pid} on this node")
        self.polls[pid] += 1
        if self.polls[pid] == 1:
            self.status_at_first_poll[pid] = self.ctx.redis.hget(f"placement:{pid}", "status")
        image = self.images[pid]
        if image == MISSING:
            return agent_pb2.HealthReply(status=agent_pb2.FAILED, reason=f"image pull failed: {image} not found")
        if image == CRASH:
            return agent_pb2.HealthReply(status=agent_pb2.FAILED, reason="container exited with code 1")
        if (image == HANG and self.starts[pid] == 1) or self.polls[pid] < 2:
            return agent_pb2.HealthReply(status=agent_pb2.STARTING)
        return agent_pb2.HealthReply(status=agent_pb2.HEALTHY)


def _node(ctx, node_id, capacity=8):
    ctx.redis.hset(f"node:{node_id}", mapping={"gpu_type": "a100", "capacity": capacity, "allocated": 0})
    ctx.redis.sadd("nodes", node_id)
    ctx.redis.set(f"heartbeat:{node_id}", "1", ex=30)


def _world(ctx, nodes=("gpu-1", "gpu-2")):
    for node_id in nodes:
        _node(ctx, node_id)
    agent = FakeAgent(ctx)
    ctx.grpc.serve(agent_pb2_grpc.add_NodeAgentServicer_to_server, agent)
    return ctx.load("client"), agent


def _allocated(ctx, node_id):
    return int(ctx.redis.hget(f"node:{node_id}", "allocated") or 0)


def _starts(ctx, node_id):
    return ctx.grpc.calls_to("Start", target=f"{node_id}:50051")


def check_deadline(ctx):
    m, _ = _world(ctx)
    outcome = m.start_placement("p-1", INFER, 4, ["gpu-1", "gpu-2"])
    assert outcome.get("status") == "running", f"a healthy start answered {outcome}"
    call = ctx.grpc.calls_to("Start")[0]
    assert call.timeout is not None, "the Start call carries no deadline: an agent that stalls holds the scheduler for as long as it likes"
    assert 1 <= call.timeout <= 20, f"the Start deadline must be START_DEADLINE_S = 20 s at most, got {call.timeout} s"
    ctx.grpc.set_latency("Start", 25.0, target="gpu-1:50051")
    before = ctx.clock.time()
    outcome = m.start_placement("p-2", INFER, 4, ["gpu-1", "gpu-2"])
    assert outcome == {"status": "running", "node_id": "gpu-2"}, f"with gpu-1's agent 25 s slow the placement must run on gpu-2 after DEADLINE_EXCEEDED, got {outcome}"
    assert ctx.clock.time() - before < 25, f"the scheduler waited {ctx.clock.time() - before:.0f} s for gpu-1's agent: the deadline is 20 s"


def check_health_gate(ctx):
    m, agent = _world(ctx)
    outcome = m.start_placement("p-1", INFER, 4, ["gpu-1"])
    assert outcome == {"status": "running", "node_id": "gpu-1"}, f"a healthy start answered {outcome}"
    assert agent.polls.get("p-1", 0) >= 2, f"Health was polled {agent.polls.get('p-1', 0)} times for p-1: poll it until the agent reports HEALTHY (it reports STARTING first)"
    assert agent.status_at_first_poll.get("p-1") == "allocated", f"at the first Health poll placement:p-1 was already {agent.status_at_first_poll.get('p-1')!r}: running is written only after HEALTHY"
    assert ctx.redis.hget("placement:p-1", "status") == "running", "after HEALTHY the placement is running"
    outcome = m.start_placement("p-2", CRASH, 2, ["gpu-1"])
    assert outcome.get("status") == "failed", f"a container that exited at once was reported {outcome}: FAILED is not running"
    assert ctx.redis.hget("placement:p-2", "status") != "running", "a placement whose container exited must not read running"


def check_image_pull_stop(ctx):
    m, _ = _world(ctx)
    outcome = m.start_placement("p-1", MISSING, 4, ["gpu-1", "gpu-2"])
    assert outcome.get("status") == "failed", f"an image that cannot be pulled answered {outcome}, expected failed"
    assert "image pull failed" in str(outcome.get("reason", "")), f"the failure must carry the agent's reason, got {outcome.get('reason')!r}"
    assert len(_starts(ctx, "gpu-2")) == 0, "an image that cannot be pulled on gpu-1 cannot be pulled on gpu-2 either: it must not be started there"
    assert len(ctx.grpc.calls_to("Start")) == 1, f"{len(ctx.grpc.calls_to('Start'))} Start calls for one bad image, expected 1"
    assert _allocated(ctx, "gpu-1") == 0, f"gpu-1 still has {_allocated(ctx, 'gpu-1')} GPUs booked for a placement that failed"


def check_rollback(ctx):
    m, _ = _world(ctx)
    outcome = m.start_placement("p-1", HANG, 4, ["gpu-1", "gpu-2"])
    assert outcome == {"status": "running", "node_id": "gpu-2"}, f"a container that never reports healthy on gpu-1 must be retried on gpu-2, got {outcome}"
    assert _allocated(ctx, "gpu-1") == 0, f"gpu-1 still has {_allocated(ctx, 'gpu-1')} GPUs booked after its start timed out: release the booking before trying the next node"
    assert not ctx.redis.sismember("node:gpu-1:placements", "p-1"), "p-1 must be released from gpu-1"
    assert _allocated(ctx, "gpu-2") == 4, f"gpu-2 holds {_allocated(ctx, 'gpu-2')} GPUs for the running placement, expected 4"
    ctx.grpc.fail("Start", grpc.StatusCode.UNAVAILABLE, "agent restarting", times=1, target="gpu-2:50051")
    outcome = m.start_placement("p-2", INFER, 2, ["gpu-2", "gpu-1"])
    assert outcome == {"status": "running", "node_id": "gpu-1"}, f"with gpu-2's agent UNAVAILABLE the placement must run on gpu-1, got {outcome}"
    assert _allocated(ctx, "gpu-2") == 4, f"gpu-2 holds {_allocated(ctx, 'gpu-2')} GPUs after a refused start, expected the 4 of p-1 only"


def check_retry_classification(ctx):
    m, _ = _world(ctx, ("gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5"))
    ctx.grpc.fail("Start", grpc.StatusCode.INVALID_ARGUMENT, "gpu_count must be positive", times=1, target="gpu-1:50051")
    outcome = m.start_placement("p-1", INFER, 4, ["gpu-1", "gpu-2"])
    assert outcome.get("status") == "failed", f"INVALID_ARGUMENT from the agent answered {outcome}: an argument error is the same on every node"
    assert len(_starts(ctx, "gpu-2")) == 0, "an argument error must not be retried on gpu-2"
    assert _allocated(ctx, "gpu-1") == 0, "the booking on gpu-1 must be released"
    ctx.grpc.fail("Start", grpc.StatusCode.UNAVAILABLE, "agent restarting", times=5)
    outcome = m.start_placement("p-2", INFER, 4, ["gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5"])
    assert outcome.get("status") == "failed", f"five agents UNAVAILABLE answered {outcome}"
    starts = len(ctx.grpc.calls_to("Start")) - 1
    assert starts <= 3, f"{starts} Start calls for one placement across unavailable agents: MAX_START_ATTEMPTS is 3"
    assert all(_allocated(ctx, n) == 0 for n in ("gpu-1", "gpu-2", "gpu-3")), "every failed node must be released"
`,
    typescript: `const INFER = 'registry/infer:1';
const MISSING = 'registry/missing:9';
const CRASH = 'registry/crash:1';
const HANG = 'registry/hang:1';

/** The node agent: the image decides what Health reports (the hang image wedges the first node it is started on). The placement's status at the first poll is remembered. */
function serveAgent(ctx) {
  const images: Record<string, string> = {};
  const polls: Record<string, number> = {};
  const statusAtFirstPoll: Record<string, string | null> = {};
  const starts: Record<string, number> = {};
  const pkg = ctx.proto('agent.proto');
  ctx.grpc.serve(pkg.gpusched.NodeAgent.service, {
    Start(call, callback) {
      const {placement_id: pid, image} = call.request;
      images[pid] = image;
      polls[pid] = 0;
      starts[pid] = (starts[pid] ?? 0) + 1;
      callback(null, {container_id: \`c-\${pid}\`});
    },
    Health(call, callback) {
      const {placement_id: pid} = call.request;
      if (!(pid in images)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no placement \${pid} on this node\`});
      polls[pid] += 1;
      if (polls[pid] === 1) statusAtFirstPoll[pid] = ctx.redis.hget(\`placement:\${pid}\`, 'status');
      const image = images[pid];
      if (image === MISSING) return callback(null, {status: 'FAILED', reason: \`image pull failed: \${image} not found\`});
      if (image === CRASH) return callback(null, {status: 'FAILED', reason: 'container exited with code 1'});
      if ((image === HANG && starts[pid] === 1) || polls[pid] < 2) return callback(null, {status: 'STARTING', reason: ''});
      callback(null, {status: 'HEALTHY', reason: ''});
    },
  });
  return {polls, statusAtFirstPoll};
}

function node(ctx, id: string): void {
  ctx.redis.hset(\`node:\${id}\`, 'gpu_type', 'a100', 'capacity', 8, 'allocated', 0);
  ctx.redis.sadd('nodes', id);
  ctx.redis.set(\`heartbeat:\${id}\`, '1', 'EX', 30);
}

function world(ctx, nodes = ['gpu-1', 'gpu-2']) {
  for (const id of nodes) node(ctx, id);
  const agent = serveAgent(ctx);
  return {m: ctx.load('client'), agent};
}

const allocated = (ctx, id: string): number => Number(ctx.redis.hget(\`node:\${id}\`, 'allocated') ?? 0);
const starts = (ctx, id: string): number => ctx.grpc.callsTo('Start', \`\${id}:50051\`).length;

export async function check_deadline(ctx) {
  const {m} = world(ctx);
  let outcome = await m.startPlacement('p-1', INFER, 4, ['gpu-1', 'gpu-2']);
  assert.equal(outcome.status, 'running', \`a healthy start answered \${JSON.stringify(outcome)}\`);
  const call = ctx.grpc.callsTo('Start')[0];
  assert(call.timeout !== null, 'the Start call carries no deadline: an agent that stalls holds the scheduler for as long as it likes');
  assert(1 <= call.timeout && call.timeout <= 20, \`the Start deadline must be START_DEADLINE_MS = 20 s at most, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Start', 25, 'gpu-1:50051');
  const before = ctx.clock.now();
  outcome = await m.startPlacement('p-2', INFER, 4, ['gpu-1', 'gpu-2']);
  assert.deepEqual(outcome, {status: 'running', node_id: 'gpu-2'}, "with gpu-1's agent 25 s slow the placement must run on gpu-2 after DEADLINE_EXCEEDED");
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 25, \`the scheduler waited \${waited.toFixed(0)} s for gpu-1's agent: the deadline is 20 s\`);
}

export async function check_health_gate(ctx) {
  const {m, agent} = world(ctx);
  let outcome = await m.startPlacement('p-1', INFER, 4, ['gpu-1']);
  assert.deepEqual(outcome, {status: 'running', node_id: 'gpu-1'}, 'a healthy start');
  assert((agent.polls['p-1'] ?? 0) >= 2, \`Health was polled \${agent.polls['p-1'] ?? 0} times for p-1: poll it until the agent reports HEALTHY (it reports STARTING first)\`);
  assert.equal(agent.statusAtFirstPoll['p-1'], 'allocated', 'placement:p-1 at the first Health poll (running is written only after HEALTHY)');
  assert.equal(ctx.redis.hget('placement:p-1', 'status'), 'running', 'after HEALTHY the placement is running');
  outcome = await m.startPlacement('p-2', CRASH, 2, ['gpu-1']);
  assert.equal(outcome.status, 'failed', \`a container that exited at once was reported \${JSON.stringify(outcome)}: FAILED is not running\`);
  assert.notEqual(ctx.redis.hget('placement:p-2', 'status'), 'running', 'a placement whose container exited must not read running');
}

export async function check_image_pull_stop(ctx) {
  const {m} = world(ctx);
  const outcome = await m.startPlacement('p-1', MISSING, 4, ['gpu-1', 'gpu-2']);
  assert.equal(outcome.status, 'failed', \`an image that cannot be pulled answered \${JSON.stringify(outcome)}\`);
  assert(String(outcome.reason ?? '').includes('image pull failed'), \`the failure must carry the agent's reason, got \${JSON.stringify(outcome.reason)}\`);
  assert.equal(starts(ctx, 'gpu-2'), 0, 'an image that cannot be pulled on gpu-1 cannot be pulled on gpu-2 either: Start calls to gpu-2');
  assert.equal(ctx.grpc.callsTo('Start').length, 1, 'Start calls for one bad image');
  assert.equal(allocated(ctx, 'gpu-1'), 0, 'GPUs still booked on gpu-1 for a placement that failed');
}

export async function check_rollback(ctx) {
  const {m} = world(ctx);
  let outcome = await m.startPlacement('p-1', HANG, 4, ['gpu-1', 'gpu-2']);
  assert.deepEqual(outcome, {status: 'running', node_id: 'gpu-2'}, 'a container that never reports healthy on gpu-1 must be retried on gpu-2');
  assert.equal(allocated(ctx, 'gpu-1'), 0, 'GPUs booked on gpu-1 after its start timed out: release the booking before trying the next node');
  assert.equal(ctx.redis.sismember('node:gpu-1:placements', 'p-1'), 0, 'p-1 must be released from gpu-1');
  assert.equal(allocated(ctx, 'gpu-2'), 4, 'GPUs gpu-2 holds for the running placement');
  ctx.grpc.fail('Start', ctx.grpc.status.UNAVAILABLE, 'agent restarting', 1, 'gpu-2:50051');
  outcome = await m.startPlacement('p-2', INFER, 2, ['gpu-2', 'gpu-1']);
  assert.deepEqual(outcome, {status: 'running', node_id: 'gpu-1'}, "with gpu-2's agent UNAVAILABLE the placement must run on gpu-1");
  assert.equal(allocated(ctx, 'gpu-2'), 4, 'GPUs gpu-2 holds after a refused start (the 4 of p-1 only)');
}

export async function check_retry_classification(ctx) {
  const {m} = world(ctx, ['gpu-1', 'gpu-2', 'gpu-3', 'gpu-4', 'gpu-5']);
  ctx.grpc.fail('Start', ctx.grpc.status.INVALID_ARGUMENT, 'gpu_count must be positive', 1, 'gpu-1:50051');
  let outcome = await m.startPlacement('p-1', INFER, 4, ['gpu-1', 'gpu-2']);
  assert.equal(outcome.status, 'failed', \`INVALID_ARGUMENT from the agent answered \${JSON.stringify(outcome)}: an argument error is the same on every node\`);
  assert.equal(starts(ctx, 'gpu-2'), 0, 'an argument error must not be retried on gpu-2: Start calls to gpu-2');
  assert.equal(allocated(ctx, 'gpu-1'), 0, 'the booking on gpu-1 must be released');
  ctx.grpc.fail('Start', ctx.grpc.status.UNAVAILABLE, 'agent restarting', 5);
  outcome = await m.startPlacement('p-2', INFER, 4, ['gpu-1', 'gpu-2', 'gpu-3', 'gpu-4', 'gpu-5']);
  assert.equal(outcome.status, 'failed', \`five agents UNAVAILABLE answered \${JSON.stringify(outcome)}\`);
  const total = ctx.grpc.callsTo('Start').length - 1;
  assert(total <= 3, \`\${total} Start calls for one placement across unavailable agents: MAX_START_ATTEMPTS is 3\`);
  for (const id of ['gpu-1', 'gpu-2', 'gpu-3']) assert.equal(allocated(ctx, id), 0, \`every failed node must be released: \${id}\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "gpusched/gen/agent"
)

const (
	clientInfer   = "registry/infer:1"
	clientMissing = "registry/missing:9"
	clientCrash   = "registry/crash:1"
	clientHang    = "registry/hang:1"
)

// agentPeer is the node agent: the image decides what Health reports (the hang image wedges the first node it is started on). The placement's status at the first poll is remembered.
type agentPeer struct {
	pb.UnimplementedNodeAgentServer
	ctx               *harness.Ctx
	images            map[string]string
	polls             map[string]int
	statusAtFirstPoll map[string]string
	starts            map[string]int
}

func (a *agentPeer) Start(_ context.Context, req *pb.StartRequest) (*pb.StartReply, error) {
	a.images[req.GetPlacementId()] = req.GetImage()
	a.polls[req.GetPlacementId()] = 0
	a.starts[req.GetPlacementId()]++
	return &pb.StartReply{ContainerId: "c-" + req.GetPlacementId()}, nil
}

func (a *agentPeer) Health(_ context.Context, req *pb.HealthRequest) (*pb.HealthReply, error) {
	pid := req.GetPlacementId()
	image, ok := a.images[pid]
	if !ok {
		return nil, status.Error(codes.NotFound, "no placement "+pid+" on this node")
	}
	a.polls[pid]++
	if a.polls[pid] == 1 {
		s, _ := a.ctx.Redis.HGet("placement:"+pid, "status")
		a.statusAtFirstPoll[pid] = s
	}
	switch {
	case image == clientMissing:
		return &pb.HealthReply{Status: pb.HealthStatus_FAILED, Reason: "image pull failed: " + image + " not found"}, nil
	case image == clientCrash:
		return &pb.HealthReply{Status: pb.HealthStatus_FAILED, Reason: "container exited with code 1"}, nil
	case (image == clientHang && a.starts[pid] == 1) || a.polls[pid] < 2:
		return &pb.HealthReply{Status: pb.HealthStatus_STARTING}, nil
	}
	return &pb.HealthReply{Status: pb.HealthStatus_HEALTHY}, nil
}

func clientNode(ctx *harness.Ctx, id string) {
	ctx.Redis.Do("HSET", "node:"+id, "gpu_type", "a100", "capacity", 8, "allocated", 0)
	ctx.Redis.Do("SADD", "nodes", id)
	ctx.Redis.Do("SET", "heartbeat:"+id, "1", "EX", 30)
}

// clientLedger stands in for allocate and release (state.go, step 2).
func clientLedger(ctx *harness.Ctx) {
	allocate = func(_ context.Context, nodeID, placementID string, count int) (string, error) {
		if ctx.Redis.Exists("heartbeat:"+nodeID) == 0 {
			return "NO_HEARTBEAT", nil
		}
		if ctx.Redis.SIsMember("node:"+nodeID+":placements", placementID) {
			return "ALLOCATED", nil
		}
		fields := ctx.Redis.HGetAll("node:" + nodeID)
		capacity, _ := strconv.Atoi(fields["capacity"])
		booked, _ := strconv.Atoi(fields["allocated"])
		if booked+count > capacity {
			return "NO_CAPACITY", nil
		}
		ctx.Redis.Do("HINCRBY", "node:"+nodeID, "allocated", count)
		ctx.Redis.Do("HSET", "placement:"+placementID, "node_id", nodeID, "count", count, "status", "allocated")
		ctx.Redis.Do("SADD", "node:"+nodeID+":placements", placementID)
		return "ALLOCATED", nil
	}
	release = func(_ context.Context, nodeID, placementID string) (bool, error) {
		if !ctx.Redis.SIsMember("node:"+nodeID+":placements", placementID) {
			return false, nil
		}
		count, _ := ctx.Redis.HGet("placement:"+placementID, "count")
		n, _ := strconv.Atoi(count)
		ctx.Redis.Do("HINCRBY", "node:"+nodeID, "allocated", -n)
		ctx.Redis.Do("HSET", "placement:"+placementID, "status", "released")
		ctx.Redis.Do("SREM", "node:"+nodeID+":placements", placementID)
		return true, nil
	}
}

func clientWorld(ctx *harness.Ctx, nodes ...string) *agentPeer {
	if len(nodes) == 0 {
		nodes = []string{"gpu-1", "gpu-2"}
	}
	for _, id := range nodes {
		clientNode(ctx, id)
	}
	clientLedger(ctx)
	peer := &agentPeer{ctx: ctx, images: map[string]string{}, polls: map[string]int{}, statusAtFirstPoll: map[string]string{}, starts: map[string]int{}}
	pb.RegisterNodeAgentServer(ctx.GRPC.Server(""), peer)
	return peer
}

func clientAllocated(ctx *harness.Ctx, id string) int {
	v, _ := ctx.Redis.HGet("node:"+id, "allocated")
	n, _ := strconv.Atoi(v)
	return n
}

func clientStarts(ctx *harness.Ctx, id string) int { return len(ctx.GRPC.CallsTo("Start", id+":50051")) }

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	outcome := startPlacement(context.Background(), "p-1", clientInfer, 4, []string{"gpu-1", "gpu-2"})
	ctx.Equal(outcome.Status, "running", "a healthy start (%+v)", outcome)
	call := ctx.GRPC.CallsTo("Start", "")[0]
	ctx.Assert(call.HasDeadline(), "the Start call carries no deadline: an agent that stalls holds the scheduler for as long as it likes")
	ctx.Assert(call.Timeout.Seconds() >= 1 && call.Timeout.Seconds() <= 20, "the Start deadline must be config.StartDeadline = 20 s at most, got %v", call.Timeout)
	ctx.GRPC.SetLatency("Start", 25, "gpu-1:50051")
	before := ctx.Clock.Now()
	outcome = startPlacement(context.Background(), "p-2", clientInfer, 4, []string{"gpu-1", "gpu-2"})
	ctx.Equal(outcome, Outcome{Status: "running", NodeID: "gpu-2"}, "with gpu-1's agent 25 s slow the placement must run on gpu-2 after DEADLINE_EXCEEDED")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited < 25, "the scheduler waited %.0f s for gpu-1's agent: the deadline is 20 s", waited)
}

func CheckHealthGate(ctx *harness.Ctx) {
	peer := clientWorld(ctx)
	outcome := startPlacement(context.Background(), "p-1", clientInfer, 4, []string{"gpu-1"})
	ctx.Equal(outcome, Outcome{Status: "running", NodeID: "gpu-1"}, "a healthy start")
	ctx.Assert(peer.polls["p-1"] >= 2, "Health was polled %d times for p-1: poll it until the agent reports HEALTHY (it reports STARTING first)", peer.polls["p-1"])
	ctx.Equal(peer.statusAtFirstPoll["p-1"], "allocated", "placement:p-1 at the first Health poll (running is written only after HEALTHY)")
	s, _ := ctx.Redis.HGet("placement:p-1", "status")
	ctx.Equal(s, "running", "after HEALTHY the placement is running; its status")
	outcome = startPlacement(context.Background(), "p-2", clientCrash, 2, []string{"gpu-1"})
	ctx.Equal(outcome.Status, "failed", "a container that exited at once was reported %+v: FAILED is not running; the status", outcome)
	s, _ = ctx.Redis.HGet("placement:p-2", "status")
	ctx.Assert(s != "running", "a placement whose container exited must not read running")
}

func CheckImagePullStop(ctx *harness.Ctx) {
	clientWorld(ctx)
	outcome := startPlacement(context.Background(), "p-1", clientMissing, 4, []string{"gpu-1", "gpu-2"})
	ctx.Equal(outcome.Status, "failed", "an image that cannot be pulled (%+v); the status", outcome)
	ctx.Assert(strings.Contains(outcome.Reason, "image pull failed"), "the failure must carry the agent's reason, got %q", outcome.Reason)
	ctx.Equal(clientStarts(ctx, "gpu-2"), 0, "an image that cannot be pulled on gpu-1 cannot be pulled on gpu-2 either: Start calls to gpu-2")
	ctx.Equal(len(ctx.GRPC.CallsTo("Start", "")), 1, "Start calls for one bad image")
	ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "GPUs still booked on gpu-1 for a placement that failed")
}

func CheckRollback(ctx *harness.Ctx) {
	clientWorld(ctx)
	outcome := startPlacement(context.Background(), "p-1", clientHang, 4, []string{"gpu-1", "gpu-2"})
	ctx.Equal(outcome, Outcome{Status: "running", NodeID: "gpu-2"}, "a container that never reports healthy on gpu-1 must be retried on gpu-2")
	ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "GPUs booked on gpu-1 after its start timed out: release the booking before trying the next node")
	ctx.Assert(!ctx.Redis.SIsMember("node:gpu-1:placements", "p-1"), "p-1 must be released from gpu-1")
	ctx.Equal(clientAllocated(ctx, "gpu-2"), 4, "GPUs gpu-2 holds for the running placement")
	ctx.GRPC.Fail("Start", codes.Unavailable, "agent restarting", 1, "gpu-2:50051")
	outcome = startPlacement(context.Background(), "p-2", clientInfer, 2, []string{"gpu-2", "gpu-1"})
	ctx.Equal(outcome, Outcome{Status: "running", NodeID: "gpu-1"}, "with gpu-2's agent UNAVAILABLE the placement must run on gpu-1")
	ctx.Equal(clientAllocated(ctx, "gpu-2"), 4, "GPUs gpu-2 holds after a refused start (the 4 of p-1 only)")
}

func CheckRetryClassification(ctx *harness.Ctx) {
	clientWorld(ctx, "gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5")
	ctx.GRPC.Fail("Start", codes.InvalidArgument, "gpu_count must be positive", 1, "gpu-1:50051")
	outcome := startPlacement(context.Background(), "p-1", clientInfer, 4, []string{"gpu-1", "gpu-2"})
	ctx.Equal(outcome.Status, "failed", "INVALID_ARGUMENT from the agent (%+v): an argument error is the same on every node; the status", outcome)
	ctx.Equal(clientStarts(ctx, "gpu-2"), 0, "an argument error must not be retried on gpu-2: Start calls to gpu-2")
	ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "the booking on gpu-1 must be released")
	ctx.GRPC.Fail("Start", codes.Unavailable, "agent restarting", 5, "")
	outcome = startPlacement(context.Background(), "p-2", clientInfer, 4, []string{"gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5"})
	ctx.Equal(outcome.Status, "failed", "five agents UNAVAILABLE (%+v); the status", outcome)
	total := len(ctx.GRPC.CallsTo("Start", "")) - 1
	ctx.Assert(total <= 3, "%d Start calls for one placement across unavailable agents: config.MaxStartAttempts is 3", total)
	for _, id := range []string{"gpu-1", "gpu-2", "gpu-3"} {
		ctx.Equal(clientAllocated(ctx, id), 0, "every failed node must be released: %s", id)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

namespace {

const std::string kInfer = "registry/infer:1";
const std::string kMissing = "registry/missing:9";
const std::string kCrash = "registry/crash:1";
const std::string kHang = "registry/hang:1";

harness::Ctx* clientCtx = nullptr;

// The node agent: the image decides what Health reports (the hang image wedges the first node it is started on). The placement's status at the first poll is remembered.
class AgentPeer final : public gpusched::NodeAgent::Service {
 public:
  std::map<std::string, std::string> images;
  std::map<std::string, int> polls;
  std::map<std::string, std::string> statusAtFirstPoll;
  std::map<std::string, int> starts;

  grpc::Status Start(grpc::ServerContext*, const gpusched::StartRequest* req, gpusched::StartReply* reply) override {
    images[req->placement_id()] = req->image();
    polls[req->placement_id()] = 0;
    starts[req->placement_id()]++;
    reply->set_container_id("c-" + req->placement_id());
    return grpc::Status::OK;
  }

  grpc::Status Health(grpc::ServerContext*, const gpusched::HealthRequest* req, gpusched::HealthReply* reply) override {
    const std::string pid = req->placement_id();
    if (!images.count(pid)) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no placement " + pid + " on this node");
    polls[pid]++;
    if (polls[pid] == 1) statusAtFirstPoll[pid] = clientCtx->Redis.HGet("placement:" + pid, "status").value_or("");
    const std::string& image = images[pid];
    if (image == kMissing) {
      reply->set_status(gpusched::FAILED);
      reply->set_reason("image pull failed: " + image + " not found");
    } else if (image == kCrash) {
      reply->set_status(gpusched::FAILED);
      reply->set_reason("container exited with code 1");
    } else if ((image == kHang && starts[pid] == 1) || polls[pid] < 2) {
      reply->set_status(gpusched::STARTING);
    } else {
      reply->set_status(gpusched::HEALTHY);
    }
    return grpc::Status::OK;
  }
};

AgentPeer* clientPeer = nullptr;

void clientNode(harness::Ctx& ctx, const std::string& id) {
  ctx.Redis.Do("HSET", "node:" + id, "gpu_type", "a100", "capacity", 8, "allocated", 0);
  ctx.Redis.Do("SADD", "nodes", id);
  ctx.Redis.Do("SET", "heartbeat:" + id, "1", "EX", 30);
}

AgentPeer& clientWorld(harness::Ctx& ctx, const std::vector<std::string>& nodes = {"gpu-1", "gpu-2"}) {
  clientCtx = &ctx;
  for (const auto& id : nodes) clientNode(ctx, id);
  delete clientPeer;
  clientPeer = new AgentPeer;
  ctx.GRPC.Server("")->RegisterService(clientPeer);
  return *clientPeer;
}

int clientAllocated(harness::Ctx& ctx, const std::string& id) {
  const auto v = ctx.Redis.HGet("node:" + id, "allocated");
  return v ? std::stoi(*v) : 0;
}

size_t clientStarts(harness::Ctx& ctx, const std::string& id) { return ctx.GRPC.CallsTo("Start", id + ":50051").size(); }

}  // namespace

// The ledger (state.cpp, step 2) as the harness stands in for it.
std::string allocate(const std::string& node_id, const std::string& placement_id, int count) {
  harness::Ctx& ctx = *clientCtx;
  if (ctx.Redis.Exists("heartbeat:" + node_id) == 0) return "NO_HEARTBEAT";
  if (ctx.Redis.SIsMember("node:" + node_id + ":placements", placement_id)) return "ALLOCATED";
  const auto fields = ctx.Redis.HGetAll("node:" + node_id);
  const int capacity = fields.count("capacity") ? std::stoi(fields.at("capacity")) : 0;
  const int booked = fields.count("allocated") ? std::stoi(fields.at("allocated")) : 0;
  if (booked + count > capacity) return "NO_CAPACITY";
  ctx.Redis.Do("HINCRBY", "node:" + node_id, "allocated", count);
  ctx.Redis.Do("HSET", "placement:" + placement_id, "node_id", node_id, "count", count, "status", "allocated");
  ctx.Redis.Do("SADD", "node:" + node_id + ":placements", placement_id);
  return "ALLOCATED";
}

bool release(const std::string& node_id, const std::string& placement_id) {
  harness::Ctx& ctx = *clientCtx;
  if (!ctx.Redis.SIsMember("node:" + node_id + ":placements", placement_id)) return false;
  const auto count = ctx.Redis.HGet("placement:" + placement_id, "count");
  ctx.Redis.Do("HINCRBY", "node:" + node_id, "allocated", -(count ? std::stoi(*count) : 0));
  ctx.Redis.Do("HSET", "placement:" + placement_id, "status", "released");
  ctx.Redis.Do("SREM", "node:" + node_id + ":placements", placement_id);
  return true;
}

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  Outcome outcome = start_placement("p-1", kInfer, 4, {"gpu-1", "gpu-2"});
  ctx.Equal(outcome.status, "running", "a healthy start (%s)", outcome.reason);
  const auto call = ctx.GRPC.CallsTo("Start")[0];
  ctx.Assert(call.HasDeadline(), "the Start call carries no deadline: an agent that stalls holds the scheduler for as long as it likes");
  ctx.Assert(1 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 20, "the Start deadline must be kStartDeadline = 20 s at most, got %vs", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Start", 25, "gpu-1:50051");
  const int64_t before = ctx.Clock.Now();
  outcome = start_placement("p-2", kInfer, 4, {"gpu-1", "gpu-2"});
  ctx.Assert(outcome.status == "running" && outcome.node_id == "gpu-2", "with gpu-1's agent 25 s slow the placement must run on gpu-2 after DEADLINE_EXCEEDED, got %s on %q", outcome.status, outcome.node_id);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited < 25, "the scheduler waited %.0f s for gpu-1's agent: the deadline is 20 s", waited);
}

void CheckHealthGate(harness::Ctx& ctx) {
  AgentPeer& peer = clientWorld(ctx);
  Outcome outcome = start_placement("p-1", kInfer, 4, {"gpu-1"});
  ctx.Assert(outcome.status == "running" && outcome.node_id == "gpu-1", "a healthy start answered %s (%s)", outcome.status, outcome.reason);
  ctx.Assert(peer.polls["p-1"] >= 2, "Health was polled %d times for p-1: poll it until the agent reports HEALTHY (it reports STARTING first)", peer.polls["p-1"]);
  ctx.Equal(peer.statusAtFirstPoll["p-1"], "allocated", "placement:p-1 at the first Health poll (running is written only after HEALTHY)");
  ctx.Equal(ctx.Redis.HGet("placement:p-1", "status"), "running", "after HEALTHY the placement is running; its status");
  outcome = start_placement("p-2", kCrash, 2, {"gpu-1"});
  ctx.Equal(outcome.status, "failed", "a container that exited at once: FAILED is not running; the status");
  ctx.Assert(ctx.Redis.HGet("placement:p-2", "status") != "running", "a placement whose container exited must not read running");
}

void CheckImagePullStop(harness::Ctx& ctx) {
  clientWorld(ctx);
  const Outcome outcome = start_placement("p-1", kMissing, 4, {"gpu-1", "gpu-2"});
  ctx.Equal(outcome.status, "failed", "an image that cannot be pulled; the status");
  ctx.Assert(outcome.reason.find("image pull failed") != std::string::npos, "the failure must carry the agent's reason, got %q", outcome.reason);
  ctx.Equal(clientStarts(ctx, "gpu-2"), 0, "an image that cannot be pulled on gpu-1 cannot be pulled on gpu-2 either: Start calls to gpu-2");
  ctx.Equal(ctx.GRPC.CallsTo("Start").size(), 1, "Start calls for one bad image");
  ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "GPUs still booked on gpu-1 for a placement that failed");
}

void CheckRollback(harness::Ctx& ctx) {
  clientWorld(ctx);
  Outcome outcome = start_placement("p-1", kHang, 4, {"gpu-1", "gpu-2"});
  ctx.Assert(outcome.status == "running" && outcome.node_id == "gpu-2", "a container that never reports healthy on gpu-1 must be retried on gpu-2, got %s on %q (%s)", outcome.status, outcome.node_id, outcome.reason);
  ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "GPUs booked on gpu-1 after its start timed out: release the booking before trying the next node");
  ctx.Assert(!ctx.Redis.SIsMember("node:gpu-1:placements", "p-1"), "p-1 must be released from gpu-1");
  ctx.Equal(clientAllocated(ctx, "gpu-2"), 4, "GPUs gpu-2 holds for the running placement");
  ctx.GRPC.Fail("Start", grpc::StatusCode::UNAVAILABLE, "agent restarting", 1, "gpu-2:50051");
  outcome = start_placement("p-2", kInfer, 2, {"gpu-2", "gpu-1"});
  ctx.Assert(outcome.status == "running" && outcome.node_id == "gpu-1", "with gpu-2's agent UNAVAILABLE the placement must run on gpu-1, got %s on %q", outcome.status, outcome.node_id);
  ctx.Equal(clientAllocated(ctx, "gpu-2"), 4, "GPUs gpu-2 holds after a refused start (the 4 of p-1 only)");
}

void CheckRetryClassification(harness::Ctx& ctx) {
  clientWorld(ctx, {"gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5"});
  ctx.GRPC.Fail("Start", grpc::StatusCode::INVALID_ARGUMENT, "gpu_count must be positive", 1, "gpu-1:50051");
  Outcome outcome = start_placement("p-1", kInfer, 4, {"gpu-1", "gpu-2"});
  ctx.Equal(outcome.status, "failed", "INVALID_ARGUMENT from the agent: an argument error is the same on every node; the status");
  ctx.Equal(clientStarts(ctx, "gpu-2"), 0, "an argument error must not be retried on gpu-2: Start calls to gpu-2");
  ctx.Equal(clientAllocated(ctx, "gpu-1"), 0, "the booking on gpu-1 must be released");
  ctx.GRPC.Fail("Start", grpc::StatusCode::UNAVAILABLE, "agent restarting", 5);
  outcome = start_placement("p-2", kInfer, 4, {"gpu-1", "gpu-2", "gpu-3", "gpu-4", "gpu-5"});
  ctx.Equal(outcome.status, "failed", "five agents UNAVAILABLE; the status");
  const int total = static_cast<int>(ctx.GRPC.CallsTo("Start").size()) - 1;
  ctx.Assert(total <= 3, "%d Start calls for one placement across unavailable agents: kMaxStartAttempts is 3", total);
  for (const std::string id : {"gpu-1", "gpu-2", "gpu-3"}) ctx.Equal(clientAllocated(ctx, id), 0, "every failed node must be released: %s", id);
}
`,
  },
  debrief: `The start path is a state machine with one budget per node: the deadline on \`Start\` and the polling loop share it, so an agent that acknowledges and then goes quiet costs 20 seconds, not a scheduler thread. \`running\` is written on the agent's word, not on the scheduler's hope, which is what makes the status in Redis mean something to the next reader. The release before every failed return is the rollback, cheap because the ledger's script is idempotent. Classifying the failure decides where to retry: a timeout or an unreachable agent says something about that node; an image that does not exist says the same thing about every node. Production agents stream health instead of being polled, and the scheduler keeps a per-placement attempt log so an operator can see which nodes refused it and why.`,
};
