import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Service discovery on the AI-era track: the course is not "put the instances in Redis", it is the
 * review you owe a model-generated registry before it routes production traffic. Scoped registration
 * inside the deployment CIDR → one atomic Redis renewal with a heartbeat-derived TTL and a single
 * address per identity → gRPC health probes with a deadline before traffic, shared through a cached
 * verdict → membership events keyed by service with an outbox → a read API that returns only
 * fresh, healthy instances and explains every exclusion.
 */
export const serviceDiscoveryProblem: Problem = {
  id: 'service-discovery',
  title: 'Service Discovery',
  tagline: 'Instances register with heartbeats and only healthy backends receive traffic.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Service Discovery

Service discovery is the piece of a platform that answers one question continuously: which instances
of this service can serve traffic right now? The visible part is a list of addresses; the parts that
decide whether the answer is true are the registration boundary, the heartbeat, the health probe,
the membership stream, and the read path that callers trust.

## The real system

Production registries refuse registrations they cannot verify: the caller is authenticated and
scoped to the service it is writing, and the address it claims must lie inside the range the
deployment actually owns. Instances then *lease* their membership: a heartbeat renews a record and
its expiry together, so a process that dies, hangs or is cut off the network leaves the routable set
on its own, without waiting for anything to notice it. Deploys move one identity — a pod ordinal, a
replica slot — to a new address atomically, because two live addresses under one identity is how a
rollout sends half its traffic to the previous version. Registration is only an intent, so nothing
routes on it: candidates are probed over gRPC under a deadline and the verdict is shared, so ten
routers do not open ten sets of sockets and two routers never disagree about the same backend. Every
membership transition is published as an event keyed by service — one ordered stream per service,
with an outbox when the broker refuses — because that stream is what every cache, dashboard and
autoscaler rebuilds itself from. And the read API returns only what is routable right now, with the
heartbeat that justifies it and a reason for everything it excluded.

## What you build here

One service, **discoveryd**, with five pieces:

1. \`POST /v1/instances\`: an authenticated, service-scoped registration whose address must be inside
   the deployment's CIDR (\`422\` outside it, \`403\` across services), stored with an expiry of three
   heartbeat intervals.
2. A **Redis** registry keyed by \`sd:{service}:{instance_id}\`: heartbeats renew the address, the
   metadata version, the heartbeat stamp and the TTL in one atomic script; version numbers only move
   forward; a deploy replaces one identity's address atomically, so one identity has one address.
3. A **gRPC** probe path: \`Health/Check\` with a 200 ms deadline before an instance is returned,
   failing instances excluded while staying registered, the verdict cached and shared for five
   seconds, and a passing probe readmitting the instance.
4. A **Kafka** membership stream: \`discovery.event\` keyed by service with \`kind\`, instance id,
   metadata version and reason; \`expired\` published only after the TTL has really lapsed; an
   idempotent, \`acks=all\` producer with an outbox row when the broker rejects the event.
5. \`GET /v1/services/{name}/instances\`: the routable set with each instance's metadata version and
   last heartbeat, exclusions explained as \`expired\`, \`stale\` or \`unhealthy\`, and enumeration
   gated behind the internal scope.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Multi-cluster and multi-region membership, DNS or xDS integration, mTLS identity provisioning, the
deployment controller that writes the CIDR, capacity-aware or latency-aware load balancing, drain
hooks, and the replay job that drains the outbox. The five pieces above are the ones that decide
whether the discovery plane is correct, isolated and shippable.`,
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
