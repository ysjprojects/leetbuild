import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Agent orchestrator on the AI-era track: the course is not "call a tool from an agent loop", it is
 * the review you owe a model-generated orchestrator before it spends a customer's money and a
 * tenant's budget. A validated, idempotent run start → one atomic Redis transition per step under a
 * worker lease → tool calls with per-tool deadlines that never replay a side effect → run-keyed
 * `agent.step` events with an outbox and a dedupe key → a bounded transcript tail behind a validated
 * cursor.
 */
export const agentOrchestratorProblem: Problem = {
  id: 'agent-orchestrator',
  title: 'Agent Orchestrator',
  tagline: 'Multi-step tool-using agents with a step budget, leases and resumable state — reviewed like production.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Agent Orchestrator

An agent orchestrator is the piece of an AI platform that turns one task string into a sequence of
tool calls: it decides which tools a run may touch, how many steps it may take, which worker is
allowed to advance it, what happens when a tool times out, and how the transcript survives a crash.
The visible part is an answer at the end; the parts that decide whether the platform is safe are the
allowlist, the budget, the lease, the tool-call policy and the event log.

## The real system

Production orchestrators are state machines with a budget, not while-loops with a prompt. A run
starts with a task, an allowlist resolved against a server-side tool catalog, and a step budget;
retries of the start request resume the same run instead of spawning twins. Every transition —
pending → running → waiting for a tool → done or failed — is one atomic operation in Redis, taken
under a lease so exactly one worker advances a run, refreshed while the worker makes progress and
allowed to expire so a crashed worker's run is recovered instead of stranded. Tool calls run over
gRPC under each tool's own deadline, with retries allowed only for read-only tools: a payment or an
email is not replayed because a socket timed out. The step budget is charged once per accepted call,
never per attempt, so retries cannot burn a run's budget. Every transition publishes a run-keyed
event so the transcript reconstructs in order, the state is committed before the event is produced,
a rejected produce leaves an outbox row, and consumers dedupe redeliveries by \`(run id, step seq)\`.
The read path pages the transcript by step sequence and refuses to serve another tenant's run.

## What you build here

One service, **orchestrator**, with five pieces:

1. \`POST /v1/agent/runs\`: an authenticated tenant, a task capped at 8 KiB, an allowlist that must
   be a subset of the server catalog, a step budget from 1 to 40, and an \`Idempotency-Key\` so a
   retry resumes the same run.
2. A **Redis** run state machine: one atomic script per transition that takes or verifies the worker
   lease, refuses a second worker on a leased run, refreshes a 30-minute TTL on progress, and lets an
   expired lease reopen the run for recovery.
3. A **gRPC** tool client: each tool's own deadline from the catalog, retries only for read-only
   tools and only on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, no retry at all once a side-effecting
   call has been accepted, and the budget charged exactly once per accepted call.
4. A **Kafka** event path: every transition produces \`agent.step\` keyed by run id with
   \`acks=all\` after the state is persisted, an outbox row when the broker rejects the produce, and a
   consumer that dedupes by \`(run id, step seq)\`.
5. \`GET /v1/agent/runs/{id}\`: run status, budget remaining and a transcript tail bounded to the last
   20 steps, with the remainder paged by a validated cursor and a foreign run answered with 404.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model planning and prompt engineering, per-tool authentication, streaming tokens to the client,
multi-region workers, cost accounting per tenant, human-in-the-loop approvals, and the vector store
behind retrieval tools. The five pieces above are the ones that decide whether an agent platform is
correct, isolated and recoverable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'start · poll', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Run API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'redis', kind: 'redis', label: 'Run state', sub: 'lease · budget · TTL', x: 44, y: 22},
      {id: 'catalog', kind: 'db', label: 'Tool catalog', sub: 'names · deadlines · effects', x: 44, y: 2},
      {id: 'worker', kind: 'service', label: 'Worker pool', sub: 'step loop', x: 44, y: 66},
      {id: 'tools', kind: 'grpc', label: 'Tool gateway', sub: 'Invoke / Stream', x: 68, y: 40},
      {id: 'kafka', kind: 'kafka', label: 'agent.step', sub: 'key = run id', x: 68, y: 68},
      {id: 'consumer', kind: 'service', label: 'Transcript consumer', sub: 'group dedupe', x: 88, y: 88},
      {id: 'transcript', kind: 'db', label: 'Transcript', sub: 'steps by seq', x: 88, y: 58},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/agent/runs'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET status · tail'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'create · read state'},
      {from: 'api', to: 'catalog', kind: 'plain', label: 'allowlist'},
      {from: 'api', to: 'transcript', kind: 'plain', label: 'tail by seq'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'CLAIM · TRANSITION'},
      {from: 'worker', to: 'catalog', kind: 'plain', label: 'deadline · side effects'},
      {from: 'worker', to: 'tools', kind: 'grpc', label: 'Invoke'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce agent.step'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'transcript', kind: 'plain', label: 'upsert (run, seq)'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
