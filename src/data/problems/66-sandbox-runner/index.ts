import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Sandbox runner: the debugging an execution path needs before it runs model-authored code on a
 * host. Declarative submissions with default-deny capabilities → Redis leases that carry the hard
 * wall-clock limit → a container call with a deadline and an isolation check → job events keyed by
 * job, carrying digests instead of bodies → a read endpoint that returns the used profile, resource
 * usage and a verified output.
 */
export const sandboxRunnerProblem: Problem = {
  id: 'sandbox-runner',
  title: 'Sandbox Runner',
  tagline: 'Run model-authored code under a Redis lease, an isolation rank check and digest-only job events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Sandbox Runner

A sandbox runner takes code a model wrote and runs it where it cannot do damage: a container with a
wall-clock limit, a declared capability set, a named isolation profile, and a result an operator can
audit later. The parts that decide whether the platform survives are the submission contract, the
lease that owns the clock, the isolation check before the code runs, the event stream, and the read
path that proves what ran.

## The real system

gVisor's \`runsc\` runs a container's syscalls through its own user-space kernel, and its
\`--network=none\` runtime flag removes external networking while keeping a loopback inside the
sandbox; a profile table that maps "no network" to that flag is the kind of grant this course
models. E2B's cloud sandboxes take a timeout at creation, extend it through \`setTimeout\` while
running, and kill the sandbox when it expires, so the lifetime lives on the platform rather than in
the client.

## What you build here

One service, **sandboxd**, with five pieces:

1. \`POST /v1/sandbox/jobs\`: an authenticated tenant, code capped at 256 KiB, a profile from an
   allowlist, a **default-deny capability** check against that profile, and an \`Idempotency-Key\`
   so a replayed submit returns the original job id.
2. A **Redis** lease per job: \`lease:{job_id}\` written with the hard maximum runtime as its TTL,
   read back on every check, a kill at the deadline, late results discarded, and jobs recovered
   after a restart.
3. A **gRPC** container client: a 30-second deadline per attempt, at most two attempts, an image
   rejection treated as terminal, a start timeout that fails the job instead of weakening the
   profile, and a rank check on the isolation the container reports.
4. A **Kafka** lifecycle stream: \`sandbox.job\` keyed by job id, one event per stage carrying
   profile, exit status, usage and the digests of code and output, an idempotent producer with
   \`acks=all\`, and an outbox row when the produce fails.
5. \`GET /v1/sandbox/jobs/{id}\`: exit status, usage, the **profile actually used**, and a
   digest-verified download; a foreign job is **404**, an unfinished job **409**.

## The debugging habit

Every starter compiles and serves the happy path. In each step you debug it, fix it, optimize what
is wasteful, and prove the fix with checks that fail on the starter and pass on yours.

## Left out on purpose

Container runtime internals (namespaces, seccomp profiles, image building), the scheduler that
places jobs on nodes, GPU passthrough, artifact storage backends, billing, the job queue's own
delivery guarantees, and any UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Sandbox API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'job store', sub: 'jobs · outbox · digests', x: 46, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'lease:{job_id}', x: 46, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'sandbox.job', sub: 'key = job id', x: 46, y: 80},
      {id: 'runner', kind: 'service', label: 'Runner', sub: 'lease · kill', x: 66, y: 50},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'group job-audit', x: 66, y: 88},
      {id: 'container', kind: 'grpc', label: 'Container service', sub: 'Start / Kill', x: 86, y: 28},
      {id: 'sandbox', kind: 'external', label: 'Sandbox node', sub: 'runc · gvisor · kata', x: 86, y: 64},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'jobs · results'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'lease · result'},
      {from: 'api', to: 'runner', kind: 'plain', label: 'dispatch'},
      {from: 'runner', to: 'redis', kind: 'redis', label: 'TTL · kill'},
      {from: 'runner', to: 'container', kind: 'grpc', label: 'Start / Kill'},
      {from: 'container', to: 'sandbox', kind: 'plain', label: 'isolated run'},
      {from: 'runner', to: 'kafka', kind: 'kafka', label: 'produce sandbox.job'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
      {from: 'audit', to: 'store', kind: 'plain', label: 'job history'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
