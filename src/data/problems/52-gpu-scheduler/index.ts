import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * GPU scheduler on the AI-era track: the course is not "accept a job and pick a machine", it is the
 * review you owe a model-generated placement path before it hands a GPU to two workloads at once.
 * Validated placement requests with fresh capacity → one atomic Redis reservation per node →
 * a gRPC start gated on a health report with a deadline and a rollback → node-keyed placement
 * events that replay against the counters → a node read that cannot double-count and is scoped to
 * operators.
 */
export const gpuSchedulerProblem: Problem = {
  id: 'gpu-scheduler',
  title: 'GPU Scheduler',
  tagline: 'Place GPU workloads on the right nodes and prove the placement is honest.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# GPU Scheduler

A GPU scheduler is the piece of an AI platform that decides which physical machine runs each job,
how much of a node's capacity that job may claim, whether the machine is alive at all, and how the
platform tells the difference between a placement that is running and a placement that merely
exists in a database. The visible part is a node id in a response; the parts that decide whether the
fleet is safe are the admission funnel, the atomic reservation, the health gate on the start call,
the event stream that can rebuild occupancy, and a read path that cannot invent free GPUs.

## The real system

Production schedulers receive placement requests from many tenants, each naming a GPU type, a count,
a memory footprint and a maximum hourly bid. They reject requests they cannot satisfy before they
queue anything, because a queued request that can never run is worse than a 400. They keep node
capacity in memory that is decremented atomically, and they treat a lapsed heartbeat as
unschedulable rather than hoping the machine comes back. They ask the node agent to start the
workload under a deadline and only mark the placement running once the agent reports it healthy;
a start that never reports health is rolled back so the GPUs return to the pool. They publish one
placement event per allocation and per release, keyed by node so a node's occupancy stream stays
ordered, and the counters are committed before the event is produced. And they never let a caller
read an arbitrary node: the node view is an operator surface, and free capacity is computed through
the same atomic path the scheduler writes, so a read can never promise GPUs a placement would refuse.

## What you build here

One service, **gpusched**, with five pieces:

1. \`POST /v1/placements\`: a placed request carries GPU type, count, memory and a max hourly bid;
   an unknown type is \`400\`, a count above any node's capacity is rejected before anything is
   queued, and capacity is read fresh — never from a snapshot cached at boot. Placements are logged
   with ids and counters, never with tenant payloads.
2. A **Redis** node ledger: per node, capacity and allocated counters move together in one atomic
   script on allocation and on release, and each node's heartbeat key carries a TTL so a node whose
   heartbeat lapses drops out of the scheduling set.
3. A **gRPC** node agent client: \`Start\` with a 20-second deadline, running only after the agent
   reports health, an image-pull rejection that stops after one node with a clear reason instead of
   retrying the whole fleet, and a rollback that releases the allocation when the deadline passes.
4. A **Kafka** placement stream: \`gpu.placement\` events keyed by node id, carrying GPU counts,
   memory and placement id, published *after* the counters commit, with an outbox row when the
   broker rejects the produce and a release event for every allocation so reconstructed utilization
   matches the ledger.
5. \`GET /v1/nodes/{id}\`: capacity, allocated and free counts computed through the same atomic path,
   a node that rebooted reconciling to its real counters, and a node view scoped to operators.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it places the demo
job, and it sounds confident. Your job in every step is the job you will have on a real AI platform
team: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version.

## Left out on purpose

Cluster autoscaling, preemption and fair-share between teams, network topology and rack affinity,
CUDA driver installation, multi-region capacity, spot bid markets, and the autoscaler's own billing
pipeline. The five pieces above are the ones that decide whether a placement is correct, isolated
and honest.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'placements · bids', x: 6, y: 34},
      {id: 'operator', kind: 'client', label: 'Operator', sub: 'node reads', x: 6, y: 82},
      {id: 'scheduler', kind: 'http', label: 'GPU Scheduler', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'registry', kind: 'db', label: 'Node registry', sub: 'capacity · heartbeat', x: 50, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'capacity counters', x: 50, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'gpu.placement', sub: 'key = node', x: 50, y: 84},
      {id: 'agent', kind: 'grpc', label: 'Node agent', sub: 'Start / Health', x: 74, y: 10},
      {id: 'fleet', kind: 'external', label: 'Other nodes', sub: 'retry target', x: 74, y: 48},
      {id: 'consumer', kind: 'service', label: 'Utilization consumer', sub: 'group by node', x: 74, y: 84},
    ],
    edges: [
      {from: 'client', to: 'scheduler', kind: 'http', label: 'POST /v1/placements'},
      {from: 'operator', to: 'scheduler', kind: 'http', label: 'GET /v1/nodes/{id}'},
      {from: 'scheduler', to: 'registry', kind: 'plain', label: 'node records'},
      {from: 'scheduler', to: 'redis', kind: 'redis', label: 'allocate · release'},
      {from: 'scheduler', to: 'agent', kind: 'grpc', label: 'Start · 20s'},
      {from: 'agent', to: 'registry', kind: 'plain', label: 'health report'},
      {from: 'scheduler', to: 'fleet', kind: 'grpc', label: 'retry on another node'},
      {from: 'scheduler', to: 'kafka', kind: 'kafka', label: 'produce gpu.placement'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume · replay'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'reconcile counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
