import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {outlierEjectionStep} from './steps/1-outlier-ejection';

/**
 * Drill: client-side round robin over three gRPC instances with outlier ejection. Transport failures
 * (UNAVAILABLE, DEADLINE_EXCEEDED) eject a target for 30 s and fail over within the call; application
 * errors pass straight through; with every target ejected the call fails fast with UNAVAILABLE.
 */
export const grpcOutlierEjectionProblem: Problem = {
  id: 'grpc-outlier-ejection',
  title: 'Client-side load balancing with outlier ejection',
  tagline:
    'Round robin over three Inventory instances: a 0.2 s deadline per attempt, eject for 30 s on UNAVAILABLE or DEADLINE_EXCEEDED, never on NOT_FOUND, fail fast when all are out.',
  difficulty: 'hard',
  concepts: ['grpc'],
  minutes: 40,
  statement: `# Client-side load balancing with outlier ejection

A gRPC channel keeps one long-lived HTTP/2 connection per backend, so balancing happens per call, and
often in the client: gRPC's \`round_robin\` policy rotates over every instance it is connected to. It only
reacts to connection state, though. An instance that accepts connections and then times out, or refuses
every call, keeps its share. **Outlier ejection** watches call outcomes instead and takes such an instance
out of the rotation for a while. Envoy's outlier detection (consecutive 5xx, a base ejection time, a cap on
how much of the cluster may be out) and gRPC's \`outlier_detection\` policy are the production versions.

The service is \`Inventory.GetStock(StockRequest{sku}) returns Stock{sku, count}\` in package
\`inventory.v1\`, served at \`inv-a:50051\`, \`inv-b:50051\` and \`inv-c:50051\`. The client is
\`Balancer(targets, deadline=0.2, eject_for=30.0)\` with \`async get_stock(sku) -> int\` (TypeScript:
\`getStock(sku): Promise<number>\`), one stub per target.

## What you build here

1. \`get_stock\`: round robin over the targets not ejected, continuing after the last one used; a 0.2 s
   deadline on every attempt; \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\` ejects the target for 30 s and the same
   call tries the next healthy one (each target at most once per call); \`NOT_FOUND\`, \`INVALID_ARGUMENT\` and
   every other code are raised at once with no retry and no ejection; with every target ejected, raise
   \`UNAVAILABLE\` without a call; after 30 s an ejected target rejoins.

## Left out on purpose

Name resolution (DNS, xDS) and a changing instance list, ejection after N consecutive failures or on
success-rate statistics, ejection time that grows with each repeat, a cap on the share of targets ejected
at once, active health checks (\`grpc.health.v1\`), weighted or least-request picking, hedged requests and
concurrent calls.`,
  diagram: {
    nodes: [
      {
        id: 'client',
        kind: 'client',
        label: 'Balancer',
        sub: 'round robin · ejected_until · 0.2 s per attempt',
        x: 22,
        y: 50,
      },
      {id: 'grpc', kind: 'grpc', label: 'Inventory × 3', sub: 'inv-a · inv-b · inv-c :50051', x: 72, y: 50},
    ],
    edges: [{from: 'client', to: 'grpc', kind: 'grpc', label: 'GetStock(sku) → Stock{count}'}],
  },
  support: {python: protoModules, typescript: protoFiles, go: protoFiles},
  steps: [outlierEjectionStep],
  learn,
};
