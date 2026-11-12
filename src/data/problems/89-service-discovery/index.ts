import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Service discovery: the course is not "put the instances in Redis", it is the debugging you owe a
 * registry before it routes production traffic. A scoped registration inside the deployment CIDR
 * that expires → one Lua heartbeat that renews metadata and TTL together → gRPC health probes with
 * a deadline and a shared verdict → membership events keyed by service, published on the real
 * expiry with an outbox → a gated read that returns only routable instances and explains the rest.
 */
export const serviceDiscoveryProblem: Problem = {
  id: 'service-discovery',
  title: 'Service Discovery',
  tagline: 'Instance records that lapse unless heartbeats renew them, probed over gRPC before a router sees them.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Service Discovery

Service discovery answers one question for every router, many times a second: which instances of
this service can take traffic right now? The list of addresses is the easy part. Whether the answer
is true depends on who may register, how a dead instance falls out, who decides that a live one is
healthy, and how every cache hears about a change.

## The real system

HashiCorp Consul splits registration from health the way this course does. A service registers
with its agent, and its health is a set of checks: a TTL check the process must refresh before it
lapses, or a gRPC check that calls the standard health protocol every \`Interval\` with a
\`Timeout\`. A critical check drops the instance from healthy query results without removing it,
and \`DeregisterCriticalServiceAfter\` sets how long a service may stay critical before the agent
deregisters it, so a brief outage is an exclusion and a long one is a removal.

## What you build here

One service, **discoveryd**, on one record layout (\`discovery.instances\`, provided): the hash
\`sd:{service}:{instance_id}\` (address, port, heartbeat_interval, metadata_version, last_heartbeat)
that expires three heartbeat intervals after its last write, the set \`sd:members:{service}\`, and
the shared probe verdict \`sd:probe:{service}:{instance_id}\`. \`discovery.registry\` holds each
service's deployment CIDR and each agent's grants; \`discovery.outbox\` is the list a relay
republishes from.

1. \`POST /v1/instances\`: a scoped registration inside the deployment CIDR, written with its expiry
   and its membership in one MULTI.
2. \`heartbeat(...)\`: one Lua script renews the record and its TTL, refuses an older
   \`metadata_version\` (\`stale\`) and never recreates a lapsed record (\`gone\`).
3. \`probe_service(service)\`: \`Health/Check\` over **gRPC** with a 200 ms deadline, the verdict
   shared in Redis for 5 s, failing instances excluded but still registered.
4. A **Kafka** \`discovery.event\` stream keyed by service: \`expired\` published once the record is
   gone, by an idempotent \`acks=all\` producer with an outbox behind its delivery report.
5. \`GET /v1/services/{service}/instances\`: the routable set for callers with the internal scope,
   and every exclusion with its reason.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Multi-cluster membership, DNS and xDS integration, mTLS identity provisioning, the deploy pipeline
that writes the CIDRs, latency-aware load balancing, drain hooks, and the relay that empties the
outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Instance agent', sub: 'register · heartbeat', x: 6, y: 26},
      {id: 'discovery', kind: 'http', label: 'Discovery API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'Deployment registry', sub: 'CIDRs · grants', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'records · members · verdicts · outbox', x: 48, y: 50},
      {id: 'instances', kind: 'grpc', label: 'Instances', sub: 'Health/Check · 200 ms', x: 48, y: 90},
      {
        id: 'reaper',
        kind: 'service',
        label: 'Probe round · expiry sweep',
        sub: '5 s verdicts · claim script',
        x: 70,
        y: 62,
      },
      {id: 'kafka', kind: 'kafka', label: 'discovery.event', sub: 'key = service', x: 70, y: 20},
      {id: 'consumer', kind: 'service', label: 'Membership consumer', sub: 'per-service cache', x: 90, y: 20},
      {id: 'router', kind: 'service', label: 'Routers', sub: 'GET instances', x: 90, y: 68},
    ],
    edges: [
      {from: 'client', to: 'discovery', kind: 'http', label: 'register · heartbeat'},
      {from: 'discovery', to: 'db', kind: 'plain', label: 'deployment_cidr · allowed_services'},
      {from: 'discovery', to: 'redis', kind: 'redis', label: 'MULTI HSET · EXPIRE 3 × interval · SADD · renew script'},
      {from: 'reaper', to: 'instances', kind: 'grpc', label: 'Health/Check · 200 ms'},
      {from: 'discovery', to: 'kafka', kind: 'kafka', label: 'produce discovery.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'membership cache'},
      {from: 'reaper', to: 'redis', kind: 'redis', label: 'SET verdict EX 5 · claim expiry · outbox'},
      {from: 'reaper', to: 'kafka', kind: 'kafka', label: 'expired · idempotent · acks=all'},
      {from: 'router', to: 'discovery', kind: 'http', label: 'GET /v1/services/{name}/instances'},
      {from: 'discovery', to: 'router', kind: 'http', label: 'routable · exclusions'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
