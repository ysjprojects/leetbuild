import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Service discovery: the course is not "put the instances in Redis", it is the debugging you owe a
 * registry before it routes production traffic. Scoped registration inside the deployment CIDR →
 * one atomic Redis renewal with a heartbeat-derived TTL and a single address per identity → gRPC
 * health probes with a deadline before traffic, shared through a cached verdict → membership
 * events keyed by service with an outbox → a read API that returns only fresh, healthy instances
 * and explains every exclusion.
 */
export const serviceDiscoveryProblem: Problem = {
  id: 'service-discovery',
  title: 'Service Discovery',
  tagline: 'A heartbeat-leased registry with gRPC probes before routing and a membership stream keyed by service.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Service Discovery

Service discovery answers one question continuously: which instances of this service can serve
traffic right now? The visible part is a list of addresses; what decides whether the answer is true
is the registration boundary, the heartbeat, the health probe, the membership stream, and the read
path that callers trust.

## The real system

HashiCorp Consul separates registration from health the way this course does. A service registers
with the local agent, and its health is a set of checks the agent runs: a TTL check that the process
must refresh before it lapses, or a gRPC check that calls the standard \`Health/Check\` protocol
every \`Interval\` with a \`Timeout\`. A check that goes critical does not remove the service by
itself; \`DeregisterCriticalServiceAfter\` names how long a service may stay critical before the
agent deregisters it, so a brief outage is an exclusion and a long one is a removal. The discovery
plane here follows the same split: a registration bounded by the deployment's CIDR, a heartbeat that
renews the record and its expiry together, a probe under a deadline whose verdict is shared across
routers, a membership stream keyed by service, and a read API that returns only what is routable
now with a reason for everything it excluded.

## What you build here

One service, **discoveryd**, with five pieces:

1. \`POST /v1/instances\`: an authenticated, service-scoped registration whose address must be inside
   the deployment's CIDR (\`422\` outside it, \`403\` across services), stored with an expiry of three
   heartbeat intervals.
2. A **Redis** registry keyed by \`sd:{service}:{instance_id}\`: heartbeats renew metadata and TTL in
   one atomic script, versions only move forward, and a deploy replaces one identity's address
   atomically.
3. A **gRPC** probe path: \`Health/Check\` with a 200 ms deadline before an instance is returned, a
   shared five-second verdict, failing instances excluded but still registered, and readmission on a
   passing probe.
4. A **Kafka** membership stream: \`discovery.event\` keyed by service, \`expired\` published only
   after the TTL has lapsed, an idempotent \`acks=all\` producer with an outbox behind it.
5. \`GET /v1/services/{name}/instances\`: the routable set with each instance's last heartbeat,
   exclusions explained as \`expired\`, \`stale\` or \`unhealthy\`, and enumeration gated behind the
   internal scope.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Multi-cluster membership, DNS or xDS integration, mTLS identity provisioning, the deployment
controller that writes the CIDR, latency-aware load balancing, drain hooks, and the replay job that
drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Instance agent', sub: 'register · heartbeat', x: 6, y: 26},
      {id: 'discovery', kind: 'http', label: 'Discovery API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'service registry · outbox', sub: 'deployments · CIDRs', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sd:{service}:{id} · TTL', x: 48, y: 50},
      {id: 'instances', kind: 'grpc', label: 'Instances', sub: 'Health/Check · 200 ms', x: 48, y: 90},
      {id: 'reaper', kind: 'service', label: 'Reaper · probe loop', sub: 'TTL sweep', x: 70, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'discovery.event', sub: 'key = service', x: 70, y: 20},
      {id: 'consumer', kind: 'service', label: 'Membership consumer', sub: 'per-service cache', x: 90, y: 20},
      {id: 'router', kind: 'service', label: 'Routers', sub: 'GET instances', x: 90, y: 68},
    ],
    edges: [
      {from: 'client', to: 'discovery', kind: 'http', label: 'register · heartbeat'},
      {from: 'discovery', to: 'db', kind: 'plain', label: 'deployments · CIDR · outbox'},
      {from: 'discovery', to: 'redis', kind: 'redis', label: 'SET … EX 3 · heartbeat_interval'},
      {from: 'discovery', to: 'instances', kind: 'grpc', label: 'Health/Check · 200 ms'},
      {from: 'discovery', to: 'kafka', kind: 'kafka', label: 'produce discovery.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'membership cache'},
      {from: 'reaper', to: 'redis', kind: 'redis', label: 'TTL sweep · probe verdicts'},
      {from: 'reaper', to: 'kafka', kind: 'kafka', label: 'expired · excluded · readmitted'},
      {from: 'router', to: 'discovery', kind: 'http', label: 'GET /v1/services/{name}/instances'},
      {from: 'discovery', to: 'router', kind: 'http', label: 'routable · exclusions'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
