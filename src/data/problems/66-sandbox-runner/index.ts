import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Sandbox runner on the AI-era track: the course is not "run code in a container", it is the review
 * you owe a model-authored execution path before it touches a host. Declarative submissions with
 * default-deny capabilities → Redis leases that carry the hard wall-clock limit → a container call
 * with a deadline and an isolation check → job events keyed by job, carrying digests instead of
 * bodies → a read endpoint that returns the used profile, resource usage and a verified output.
 */
export const sandboxRunnerProblem: Problem = {
  id: 'sandbox-runner',
  title: 'Sandbox Runner',
  tagline: 'Execute model-authored code in isolation with hard limits and reproducible logs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Sandbox Runner

A sandbox runner is the piece of an AI platform that takes code a model wrote and runs it somewhere
it cannot do damage: a container with a wall-clock limit, a declared capability set, a named
isolation profile, and a result an operator can audit later. The visible part is "the job finished";
the parts that decide whether the platform survives are the submission contract, the lease that owns
the clock, the isolation check before the code runs, the event stream nobody can mine for tenant
data, and a read path that proves what actually ran.

## The real system

Production runners receive programs from many tenants, at sizes a human did not write. They cap them,
they make the caller *declare* what the job needs, and they grant capabilities from a profile table
rather than from the request. They give every job a lease with a hard maximum runtime so a runaway
program ends on schedule even if the runner restarts. They call a container service under a deadline
and check that the isolation they got is the isolation they asked for, because a silently downgraded
profile is a job running on the host. They publish lifecycle events keyed by job so the history stays
ordered, carrying digests rather than the code and output bodies, with an outbox for the produce that
fails. And they never serve a result they cannot attribute: the used profile, the resource usage and
a digest-verified output, scoped to the tenant that submitted it.

## What you build here

One service, **sandboxd**, with five pieces:

1. \`POST /v1/sandbox/jobs\`: an authenticated tenant, code capped at 256 KiB, a declared entry
   point, a profile from an allowlist, a **default-deny capability** check against that profile, and
   an \`Idempotency-Key\` so a replayed submit returns the original job id instead of running the
   body again.
2. A **Redis** lease per job: \`lease:{job_id}\` written with the hard maximum runtime as its TTL,
   read back on every check, enforced with a kill at the deadline, discarding any result written
   after the lease lapsed, and recovered from Redis when the runner restarts.
3. A **gRPC** container client: a 30-second deadline per attempt, at most two attempts, an image
   rejection treated as terminal, a start timeout that fails the job instead of weakening the
   profile, and a rank check that refuses a container reporting a weaker isolation than requested.
4. A **Kafka** lifecycle stream: \`sandbox.job\` keyed by job id, one event per stage with profile,
   exit status, resource usage and the digests of code and output — never the bodies — an idempotent
   producer with \`acks=all\`, and an outbox row when the broker rejects the produce.
5. \`GET /v1/sandbox/jobs/{id}\`: the result with provenance — exit status, usage, the **profile
   actually used**, and a digest-verified download for the output; a foreign job is **404** and an
   unfinished job is **409**.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Container runtime internals (namespaces, seccomp profiles, image building), the scheduler that places
jobs on nodes, GPU passthrough, artifact storage backends, billing for execution time, the job
queue's own delivery guarantees, and any UI. The five pieces above are the ones that decide whether
the sandbox is correct, isolated and auditable.`,
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
