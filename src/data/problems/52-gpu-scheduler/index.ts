import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModulesCpp, supportModulesGo, supportModulesPy, supportModulesScala, supportModulesTs} from './support';

/**
 * GPU scheduler: the placement path of an AI platform, debugged before it hands a GPU to two
 * workloads at once. Validated placement requests against fresh capacity → one Lua script per node
 * ledger with a heartbeat and an idempotent release → a gRPC start gated on the agent's health
 * report, with a deadline and a rollback → node-keyed placement events produced after the counters
 * commit, with an outbox → an operator-only node read that cannot double-count.
 */
export const gpuSchedulerProblem: Problem = {
  id: 'gpu-scheduler',
  title: 'GPU Scheduler',
  tagline:
    'The placement path of an AI platform: admission, a Redis node ledger, a health-gated start, a placement stream.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# GPU Scheduler

A GPU scheduler decides which machine runs each workload, how much of that machine the workload
may claim, whether the machine is alive at all, and when a placement counts as running rather than
merely recorded. The visible part is a node id in a response; the parts that keep a fleet safe are
the admission check, the atomic reservation, the health gate on the start call, the event stream
that can rebuild occupancy, and a read path that cannot invent free GPUs.

## The real system

Kubernetes keeps this shape for every node: the kubelet renews a Lease object in the
\`kube-node-lease\` namespace every 10 seconds, and when the node controller has not heard from a
node for \`node-monitor-grace-period\` (50 seconds by default) it marks the node's \`Ready\`
condition \`Unknown\` and taints it so the scheduler stops placing pods there. Device plugins report
how many GPUs a node has, the scheduler counts them against pod requests, and a pod is \`Running\`
only once its containers pass their startup probes. Slurm and Ray keep the same three ideas
(capacity counters, a liveness deadline, a start that is confirmed rather than assumed) with their
own vocabulary.

## What you build here

One service, **gpusched**, over Redis, Kafka and a gRPC node agent, with the \`gpusched\` support
package holding the constants and the key scheme every step shares:

1. \`POST /v1/placements\` with \`{"gpu_type", "count", "memory_gb", "max_hourly_bid"}\`: a known
   type, a count between 1 and \`MAX_NODE_GPUS\`, the node set read from Redis on every request, then
   one call to the ledger. \`201\` with \`placement_id\`, \`node_id\` and \`free\`; \`409\` when no node
   can take it.
2. The **Redis node ledger**: \`node:{id}\` with \`gpu_type\`, \`capacity\` and \`allocated\`;
   \`heartbeat:{id}\` with a 30-second TTL; \`placement:{pid}\` and \`node:{id}:placements\`. One
   Lua script admits and books a placement, one releases it, both keyed by the placement id.
3. The **gRPC start**: \`Start\` on the node's agent under a 20-second budget, \`Health\` polled until
   the agent reports healthy, a rollback through \`release\` on every failure, a retry on another
   node only for retryable failures.
4. The **placement stream**: one \`gpu.placement\` event per allocation and per release, keyed by
   node id, produced after the ledger commits, with an outbox for what the broker refuses.
5. \`GET /v1/nodes/{id}\` for operators (a bearer token the service resolves in Redis): live
   counters, \`free\` clamped at zero, and a reconcile that recomputes \`allocated\` from the open
   placements.

## Left out on purpose

Autoscaling, preemption and fair share between teams, rack affinity, driver installation,
multi-region capacity and billing. The five pieces above decide whether a placement is correct,
isolated and recoverable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'POST /v1/placements', x: 6, y: 34},
      {id: 'operator', kind: 'client', label: 'Operator', sub: 'bearer token', x: 6, y: 82},
      {id: 'scheduler', kind: 'http', label: 'gpusched', sub: 'HTTP :8443', x: 30, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'node:{id} · placement:{pid} · heartbeat:{id}', x: 56, y: 22},
      {id: 'agent', kind: 'grpc', label: 'Node agent', sub: '{node}:50051 · Start / Health', x: 56, y: 58},
      {id: 'kafka', kind: 'kafka', label: 'gpu.placement', sub: 'key = node id', x: 56, y: 88},
      {id: 'consumer', kind: 'service', label: 'utilization', sub: 'folds the stream', x: 84, y: 88},
    ],
    edges: [
      {from: 'client', to: 'scheduler', kind: 'http', label: 'POST /v1/placements'},
      {from: 'operator', to: 'scheduler', kind: 'http', label: 'GET /v1/nodes/{id}'},
      {from: 'scheduler', to: 'redis', kind: 'redis', label: 'EVAL allocate · release'},
      {from: 'scheduler', to: 'agent', kind: 'grpc', label: 'Start · Health · 20 s'},
      {from: 'scheduler', to: 'kafka', kind: 'kafka', label: 'produce after commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModulesPy},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
