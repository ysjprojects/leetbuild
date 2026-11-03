import {scalaPath} from '../scala-support';

/**
 * The `gpusched` support package: the constants, key scheme and addresses every step of the GPU
 * scheduler agrees on, in five languages. The node agent's protos are generated beside it
 * (`proto.ts`). C++ also gets `state.h`, the ledger's declarations as the later steps call them
 * (step 2 defines them; the other steps' harnesses stand in for it).
 */
const PY_CONFIG = `"""
Constants every step of the GPU scheduler agrees on.

Redis keys:
  nodes                     set of node ids the scheduler may place on
  node:{id}                 hash: gpu_type, capacity, allocated
  heartbeat:{id}            "1" with a TTL of HEARTBEAT_TTL_S; while it exists the node is alive
  placement:{pid}           hash: node_id, count, status (allocated | running | released)
  node:{id}:placements      set of placement ids allocated on the node and not released
  token:{token}             hash: scope (operator | tenant), tenant
  outbox:gpu.placement      list of events the broker refused, relayed later
"""
KNOWN_GPU_TYPES = frozenset({"a100", "h100", "l40s"})
MAX_NODE_GPUS = 8
HEARTBEAT_TTL_S = 30
START_DEADLINE_S = 20.0
HEALTH_POLL_S = 1.0
MAX_START_ATTEMPTS = 3
AGENT_PORT = 50051
TOPIC = "gpu.placement"
OUTBOX = "outbox:gpu.placement"
REBUILD_GROUP = "utilization-rebuild"


def agent_target(node_id: str) -> str:
    """The node agent's address: one instance per node."""
    return f"{node_id}:{AGENT_PORT}"
`;

const TS_CONFIG = `/**
 * Constants every step of the GPU scheduler agrees on.
 *
 * Redis keys:
 *   nodes                     set of node ids the scheduler may place on
 *   node:{id}                 hash: gpu_type, capacity, allocated
 *   heartbeat:{id}            "1" with a TTL of HEARTBEAT_TTL_S; while it exists the node is alive
 *   placement:{pid}           hash: node_id, count, status (allocated | running | released)
 *   node:{id}:placements      set of placement ids allocated on the node and not released
 *   token:{token}             hash: scope (operator | tenant), tenant
 *   outbox:gpu.placement      list of events the broker refused, relayed later
 */
export const KNOWN_GPU_TYPES: Record<string, true> = {a100: true, h100: true, l40s: true};
export const MAX_NODE_GPUS = 8;
export const HEARTBEAT_TTL_S = 30;
export const START_DEADLINE_MS = 20_000;
export const HEALTH_POLL_MS = 1_000;
export const MAX_START_ATTEMPTS = 3;
export const AGENT_PORT = 50051;
export const TOPIC = 'gpu.placement';
export const OUTBOX = 'outbox:gpu.placement';
export const REBUILD_GROUP = 'utilization-rebuild';

/** The node agent's address: one instance per node. */
export const agentTarget = (nodeId: string): string => \`\${nodeId}:\${AGENT_PORT}\`;
`;

const GO_CONFIG = `// Package config holds the constants every step of the GPU scheduler agrees on.
//
// Redis keys:
//
//	nodes                     set of node ids the scheduler may place on
//	node:{id}                 hash: gpu_type, capacity, allocated
//	heartbeat:{id}            "1" with a TTL of HeartbeatTTL; while it exists the node is alive
//	placement:{pid}           hash: node_id, count, status (allocated | running | released)
//	node:{id}:placements      set of placement ids allocated on the node and not released
//	token:{token}             hash: scope (operator | tenant), tenant
//	outbox:gpu.placement      list of events the broker refused, relayed later
package config

import (
	"fmt"
	"time"
)

var KnownGPUTypes = map[string]bool{"a100": true, "h100": true, "l40s": true}

const (
	MaxNodeGPUs      = 8
	HeartbeatTTL     = 30 * time.Second
	StartDeadline    = 20 * time.Second
	HealthPoll       = time.Second
	MaxStartAttempts = 3
	AgentPort        = 50051
	Topic            = "gpu.placement"
	Outbox           = "outbox:gpu.placement"
	RebuildGroup     = "utilization-rebuild"
)

// AgentTarget is the node agent's address: one instance per node.
func AgentTarget(nodeID string) string { return fmt.Sprintf("%s:%d", nodeID, AgentPort) }
`;

const CPP_CONFIG = `// Constants every step of the GPU scheduler agrees on (gpusched::k…).
//
// Redis keys:
//   nodes                     set of node ids the scheduler may place on
//   node:{id}                 hash: gpu_type, capacity, allocated
//   heartbeat:{id}            "1" with a TTL of kHeartbeatTtlS; while it exists the node is alive
//   placement:{pid}           hash: node_id, count, status (allocated | running | released)
//   node:{id}:placements      set of placement ids allocated on the node and not released
//   token:{token}             hash: scope (operator | tenant), tenant
//   outbox:gpu.placement      list of events the broker refused, relayed later
#pragma once

#include <chrono>
#include <set>
#include <string>

namespace gpusched {

inline const std::set<std::string> kKnownGpuTypes = {"a100", "h100", "l40s"};
inline constexpr int kMaxNodeGpus = 8;
inline constexpr int kHeartbeatTtlS = 30;
inline constexpr std::chrono::seconds kStartDeadline{20};
inline constexpr std::chrono::seconds kHealthPoll{1};
inline constexpr int kMaxStartAttempts = 3;
inline constexpr int kAgentPort = 50051;
inline constexpr const char* kTopic = "gpu.placement";
inline constexpr const char* kOutbox = "outbox:gpu.placement";
inline constexpr const char* kRebuildGroup = "utilization-rebuild";

// The node agent's address: one instance per node.
inline std::string agent_target(const std::string& node_id) { return node_id + ":" + std::to_string(kAgentPort); }

}  // namespace gpusched
`;

const CPP_STATE_H = `// The node ledger (step 2, state.cpp) as the other steps call it. Step 2 defines these; in the other
// steps' checks the harness stands in for it.
#pragma once

#include <string>

// Writes node:{id} (gpu_type, capacity, allocated 0 unless set), adds the node to nodes and sets
// heartbeat:{id} with its TTL.
void register_node(const std::string& node_id, const std::string& gpu_type, int capacity);
// Refreshes heartbeat:{id}.
void heartbeat(const std::string& node_id);
// Books count GPUs of the node for the placement: "ALLOCATED", "NO_CAPACITY" or "NO_HEARTBEAT".
std::string allocate(const std::string& node_id, const std::string& placement_id, int count);
// Returns the placement's GPUs to the node; true when the counters moved (false on a repeat).
bool release(const std::string& node_id, const std::string& placement_id);
`;

const SCALA_CONFIG = `package gpusched

/** Constants every step of the GPU scheduler agrees on.
  *
  * Redis keys:
  *   nodes                     set of node ids the scheduler may place on
  *   node:{id}                 hash: gpu_type, capacity, allocated
  *   heartbeat:{id}            "1" with a TTL of HeartbeatTtlS; while it exists the node is alive
  *   placement:{pid}           hash: node_id, count, status (allocated | running | released)
  *   node:{id}:placements      set of placement ids allocated on the node and not released
  *   token:{token}             hash: scope (operator | tenant), tenant
  *   outbox:gpu.placement      list of events the broker refused, relayed later
  */
object Config {
  val KnownGpuTypes: Set[String] = Set("a100", "h100", "l40s")
  val MaxNodeGpus = 8
  val HeartbeatTtlS = 30L
  val StartDeadlineMillis = 20000L
  val HealthPollMillis = 1000L
  val MaxStartAttempts = 3
  val AgentPort = 50051
  val Topic = "gpu.placement"
  val Outbox = "outbox:gpu.placement"
  val RebuildGroup = "utilization-rebuild"

  /** The node agent's address: one instance per node. */
  def agentTarget(nodeId: String): String = s"$nodeId:$AgentPort"
}
`;

export const supportModulesPy: Record<string, string> = {
  'gpusched/__init__.py': '',
  'gpusched/config.py': PY_CONFIG,
};

export const supportModulesTs: Record<string, string> = {
  'gpusched/config.ts': TS_CONFIG,
};

export const supportModulesGo: Record<string, string> = {
  'gpusched/config/config.go': GO_CONFIG,
};

export const supportModulesCpp: Record<string, string> = {
  'gpusched/config.h': CPP_CONFIG,
  'state.h': CPP_STATE_H,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('gpusched', 'Config')]: SCALA_CONFIG,
};
