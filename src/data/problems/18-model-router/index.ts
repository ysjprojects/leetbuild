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

A model router is the piece of an AI platform that decides which model serves each request, how much
each tenant may spend, how provider failures are survived, and how a new routing policy reaches
production. The visible part is a model name in a response; the parts that decide whether the
platform is safe are the validation funnel, the atomic budget, the failure policy, and the gate in
front of every traffic increase.

## The real system

LiteLLM's proxy is an open source router of this shape: \`model_list\` names the deployments behind
one model name, \`router_settings.fallbacks\` maps a model group to the groups tried when it fails,
and \`num_retries\` with \`request_timeout\` bound each call before the fallback is reached. The same
jobs show up in every production router: estimate cost before spending it and reserve budget
atomically so two concurrent requests cannot both pass the same check; select models from a
policy, not from whatever string a caller sends; call providers under a deadline, retry only the
statuses that are worth retrying, fail over to a smaller model, and stop hammering a provider that
is already down; emit one feedback event per request, keyed by tenant so quality signals stay
ordered, without copying prompt text into a topic that is retained and replicated; and gate every
traffic increase on eval scores, with rollbacks that pin each tenant's version so no conversation
flips models mid-session.

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

Every starter in this course is working code with flaws: it compiles, it serves the happy path,
and it looks right. Your job in every step is the job you will have on a real feature: debug it
against the failure modes, fix it, optimize what is wasteful, and prove the fix with checks that
fail on the starter and pass on your version.

## Left out on purpose

Provider account management, prompt tokenizers per model, streaming to the browser, multi-region
failover, cost accounting and invoicing, policy authoring UIs, and eval set management. The five
pieces above are the ones that decide whether the router is correct, isolated and shippable.`,
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
