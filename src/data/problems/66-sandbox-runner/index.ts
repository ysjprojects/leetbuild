import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Sandbox runner: the debugging an execution path needs before it runs model-authored code on a
 * host. One job store (`sandbox.jobs`, provided) under five steps: a submit with default-deny
 * capabilities → a Redis lease that owns the wall clock → a container call that refuses weaker
 * isolation → job events keyed by job, carrying digests instead of bodies → a tenant-scoped read
 * that serves output only when its digest still matches.
 */
export const sandboxRunnerProblem: Problem = {
  id: 'sandbox-runner',
  title: 'Sandbox Runner',
  tagline: 'Model-authored code under a Redis lease, killed when a node starts it weaker than asked.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Sandbox Runner

A sandbox runner takes code a model wrote and runs it where it cannot do damage: a container with a
declared capability set, a named isolation profile, a hard wall-clock limit, and a record an
operator can audit later. What decides whether the platform survives is the submit contract, the
lease that owns the clock, the isolation check before the code runs, the event stream, and the read
that proves what ran.

## The real system

gVisor's \`runsc\` runs a container's syscalls through its own user-space kernel, and its
\`--network=none\` flag removes external networking while keeping a loopback inside the sandbox; a
profile table that maps "no network" to that flag is the kind of grant this course models. E2B's
cloud sandboxes take a timeout at creation, extend it through \`setTimeout\` while running, and kill
the sandbox when it expires, so the lifetime lives on the platform rather than in the client.

## What you build here

One service, **sandboxd**, on one job store (\`sandbox.jobs\`, provided in every language):
\`job:{id}\` hashes with the tenant, the requested \`profile\`, \`needs\`, \`status\` (queued, running,
finished), \`used_profile\`, \`exit_code\`, \`cpu_ms\`, \`mem_mb\`, \`code_digest\` and \`output_digest\`;
the code and the output beside them; \`idem:{tenant}:{key}\`; the \`outbox\` list; and
\`digest(text)\`, the SHA-256 every step compares.

1. \`POST /v1/sandbox/jobs\` (\`X-Tenant-Id\`, \`Idempotency-Key\`, \`{code, profile, needs}\` → **202**
   \`{job_id, profile, code_digest}\`): a 256 KiB cap, a profile allowlist, default-deny
   capabilities, and a replay that answers the original job.
2. A **Redis** lease per job, \`lease:{job_id}\`, taken with \`SET NX EX 300\`: \`acquire\`,
   \`remaining\` (its TTL) and \`finish\`, which claims the lease with \`DEL\` before storing a result.
3. A **gRPC** container client, \`start_container(job_id, image, profile)\` on \`sandboxd.Containers\`
   (\`Start\`, \`Kill\` in \`sandbox_containers.proto\`): a 30 s deadline, one retry of \`UNAVAILABLE\`
   only, and a kill when the node reports weaker isolation than asked.
4. A **Kafka** \`sandbox.job\` stream, \`publish(job_id, stage)\`: keyed by job id, digests and usage
   instead of code and output, idempotent with \`acks=all\`, an outbox row when the delivery fails.
5. \`GET /v1/sandbox/jobs/{id}\`: 404 for a foreign job, 409 until it finished, the \`used_profile\`,
   and output served only while its digest matches.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Container runtime internals (namespaces, seccomp profiles, image building), the scheduler that
places jobs on nodes, GPU passthrough, artifact storage backends, billing, the job queue's own
delivery guarantees, and any UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Sandbox API', sub: 'POST · GET /v1/sandbox/jobs', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'job:{id} · lease:{id} · outbox', x: 46, y: 16},
      {id: 'runner', kind: 'service', label: 'Runner', sub: 'lease · start · publish', x: 46, y: 62},
      {id: 'container', kind: 'grpc', label: 'Container service', sub: 'Start / Kill', x: 70, y: 40},
      {id: 'sandbox', kind: 'external', label: 'Sandbox node', sub: 'runc · gvisor · kata', x: 92, y: 40},
      {id: 'kafka', kind: 'kafka', label: 'sandbox.job', sub: 'key = job id', x: 70, y: 86},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'job history', x: 92, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'jobs · idem keys'},
      {from: 'api', to: 'runner', kind: 'plain', label: 'dispatch'},
      {from: 'runner', to: 'redis', kind: 'redis', label: 'lease TTL · results'},
      {from: 'runner', to: 'container', kind: 'grpc', label: 'Start / Kill'},
      {from: 'container', to: 'sandbox', kind: 'plain', label: 'isolated run'},
      {from: 'runner', to: 'kafka', kind: 'kafka', label: 'produce sandbox.job'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
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
