import type {Problem} from '@/lib/types';

import {chatEndpointStep} from './steps/1-chat-endpoint';
import {tenantBudgetStep} from './steps/2-tenant-budget';
import {streamingCancelStep} from './steps/3-streaming-cancel';
import {providerFailoverStep} from './steps/4-provider-failover';
import {usageEventsStep} from './steps/5-usage-events';

/**
 * LLM gateway: the gateway every product team puts in front of a model provider. Each step starts
 * from a plausible AI-generated draft that passes the happy path, and asks the learner to review
 * it: tighten the request contract, make the tenant budget atomic, stop paying for cancelled
 * streams, fail over without double-charging, and emit usage exactly once.
 */
export const aiGatewayProblem: Problem = {
  id: 'ai-gateway',
  title: 'LLM Gateway',
  tagline:
    'One gateway in front of model providers: validated chat, atomic budgets, cancellable streams, safe failover, billed usage.',
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 60,
  statement: `# LLM Gateway

Every product that ships a chat box eventually grows the same service: one **LLM gateway** that
authenticates tenants, enforces a token budget, calls one or more model providers, streams tokens
back to the browser, and emits usage that billing can trust. The gateway is where an AI feature
becomes a multi-tenant system.

## The real system

OpenAI's edge, Anthropic's API, and every company's internal AI platform do the same four things:
they put a validated, authenticated boundary in front of the models; they enforce per-tenant rate
and token budgets atomically; they cancel upstream work the moment a client goes away; and they
account for every token exactly once, even when a provider times out or a broker is unavailable.
The hard part is rarely the model call. It is the review of the code around it: the deadline that
was forgotten, the read-then-decrement that raced, the stream that kept generating after the user
closed the tab, the retry that charged twice, the event that was dropped on a bad Kafka day.

## What you build here

One service, **gateway**, in five pieces:

1. \`POST /v1/chat\` with tenant authentication, request validation, a bounded provider call, and a
   response that reports provider usage without echoing the prompt.
2. A daily **token budget** in Redis, reserved with one atomic Lua script and a TTL, returning
   \`429\`, \`Retry-After\` and \`X-RateLimit-Remaining\` when the tenant is out.
3. \`POST /v1/chat/stream\` as SSE, checking for client disconnect and cancelling the upstream
   stream instead of paying for tokens nobody reads.
4. **Provider failover** over gRPC: one fallback, per-attempt deadlines, retryable codes, a circuit
   breaker, an idempotency key, and no replay after the first token.
5. One **usage** event per request to Kafka, keyed by tenant, with an outbox fallback and a billing
   consumer that increments Redis before it commits.

## The review premise

Every starter in this course is a plausible model-generated draft. It compiles, it passes the happy
path, and it reads like the examples in the provider's documentation. Your job is not to rewrite it
from scratch: read it as a reviewer, find the subtle failure mode, make the smallest correct fix,
and prove the fix with the checks.

## Left out on purpose

Model routing and prompt templates, provider SDK details, API-key vaulting, streaming tokenisation,
and the analytics warehouse. The five pieces above are the ones that decide whether the gateway is
safe to put in front of paying tenants.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'chat · SSE stream', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'Gateway', sub: 'HTTPS :8443', x: 30, y: 50},
      {id: 'budget', kind: 'redis', label: 'Redis', sub: 'budget · circuit', x: 52, y: 16},
      {id: 'providers', kind: 'grpc', label: 'Model providers', sub: 'Primary · fallback', x: 52, y: 50},
      {id: 'usage', kind: 'kafka', label: 'usage', sub: 'key = tenant', x: 74, y: 50},
      {id: 'billing', kind: 'service', label: 'Billing', sub: 'consumer group', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'POST /v1/chat'},
      {from: 'gateway', to: 'budget', kind: 'redis', label: 'EVAL · circuit'},
      {from: 'gateway', to: 'providers', kind: 'grpc', label: 'Complete · Stream'},
      {from: 'gateway', to: 'usage', kind: 'kafka', label: 'produce'},
      {from: 'usage', to: 'billing', kind: 'kafka', label: 'consume'},
      {from: 'billing', to: 'budget', kind: 'redis', label: 'HINCRBY'},
    ],
  },
  steps: [chatEndpointStep, tenantBudgetStep, streamingCancelStep, providerFailoverStep, usageEventsStep],
};
