import type {Problem} from '@/lib/types';

import {routeEndpointStep} from './steps/1-route-endpoint';
import {tenantLimitsStep} from './steps/2-tenant-limits';
import {modelCallStep} from './steps/3-model-call';
import {feedbackEventsStep} from './steps/4-feedback-events';
import {rolloutStep} from './steps/5-rollout';

/**
 * Model router: the course is not "call an LLM from an endpoint", it is the debugging you owe a
 * routing layer before it spends a tenant's budget. Validated, idempotent routing decisions, one
 * atomic Redis reservation per tenant window, a provider call with a deadline, bounded retries,
 * a fallback and a breaker, tenant-keyed feedback events with an outbox and counters before the
 * offset commit, and a canary rollout gated by evals with per-tenant pins.
 */
export const modelRouterProblem: Problem = {
  id: 'model-router',
  title: 'Model Router',
  tagline:
    'Route requests across a small and a large model with Redis budgets, provider deadlines and eval-gated canaries.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Model Router

A model router decides which model serves each request, how much each tenant may spend, how provider
failures are survived, and how a new routing policy reaches production.

## The real system

LiteLLM's proxy is an open source router of this shape: \`model_list\` names the deployments behind
one model name, \`router_settings.fallbacks\` maps a model group to the groups tried when it fails,
and \`num_retries\` with \`request_timeout\` bound each call before the fallback is reached. This
course adds what sits around that: an atomic budget, policy-chosen models, prompt-free feedback
events, and an eval gate in front of every traffic increase.

## What you build here

One service, **routerd**, with five pieces:

1. \`POST /v1/route\`: authenticated tenant, validated prompt and token caps, server-side policy
   selection between a small and a large model, and an \`Idempotency-Key\` so a retry cannot
   double-route. Decisions are logged with ids, not the prompt.
2. A **Redis** limiter: per tenant, 60 requests and 100 000 tokens per 60-second window, reserved by
   one atomic Lua \`EVAL\` with the expiry set at first write, answering \`429\` with
   \`Retry-After\` and \`X-RateLimit-Remaining\` before any provider call.
3. A **gRPC** provider client: an 800 ms deadline per attempt, at most three attempts, retries only
   on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a fallback model, a breaker after five failures for
   30 seconds, and no replay once the first token has been delivered.
4. A **Kafka** feedback path: one \`route.feedback\` event per request keyed by tenant, an
   idempotent producer with \`acks=all\`, no prompt text in the event or the logs, an outbox row when
   the broker rejects the produce, and a consumer that updates Redis quality counters before it
   commits the offset.
5. \`POST /v1/policies/{policy}/rollout\`: validated percentage and version, an eval gate before
   traffic increases, a per-tenant pin during rollback, and a response that reports the caller's
   active assignment.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Provider accounts, per-model tokenizers, browser streaming, multi-region failover, invoicing, policy
authoring UIs and eval set management.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'route · feedback', x: 8, y: 50},
      {id: 'router', kind: 'http', label: 'Model Router', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'policy · outbox', sub: 'versions · pins', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'limits · quality', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'route.feedback', sub: 'key = tenant', x: 44, y: 86},
      {id: 'provider', kind: 'grpc', label: 'Provider', sub: 'Complete / Stream', x: 66, y: 12},
      {id: 'fallback', kind: 'external', label: 'Fallback model', sub: 'smaller · same API', x: 66, y: 38},
      {id: 'eval', kind: 'service', label: 'Eval service', sub: 'golden set · scores', x: 66, y: 62},
      {id: 'consumer', kind: 'service', label: 'Feedback consumer', sub: 'group quality', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'router', kind: 'http', label: 'HTTPS'},
      {from: 'router', to: 'db', kind: 'plain', label: 'policy · outbox'},
      {from: 'router', to: 'redis', kind: 'redis', label: 'limits · quality'},
      {from: 'router', to: 'provider', kind: 'grpc', label: 'Complete / Stream'},
      {from: 'router', to: 'fallback', kind: 'grpc', label: 'on UNAVAILABLE'},
      {from: 'router', to: 'eval', kind: 'plain', label: 'eval gate'},
      {from: 'router', to: 'kafka', kind: 'kafka', label: 'produce route.feedback'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY quality'},
      {from: 'eval', to: 'db', kind: 'plain', label: 'version scores'},
    ],
  },
  steps: [routeEndpointStep, tenantLimitsStep, modelCallStep, feedbackEventsStep, rolloutStep],
};
