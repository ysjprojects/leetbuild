import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {chatEndpointStep} from './steps/1-chat-endpoint';
import {tenantBudgetStep} from './steps/2-tenant-budget';
import {streamingCancelStep} from './steps/3-streaming-cancel';
import {providerFailoverStep} from './steps/4-provider-failover';
import {usageEventsStep} from './steps/5-usage-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * LLM gateway: the service every product puts in front of a model provider. Each step starts from
 * a starter that serves the demo and hides flaws the learner debugs: validation that runs after the
 * paid call, a budget that overspends under concurrency, a stream that keeps generating after the
 * tab closes, a retry loop that cannot stop, and a usage event the billing consumer loses.
 */
export const aiGatewayProblem: Problem = {
  id: 'ai-gateway',
  title: 'LLM Gateway',
  tagline:
    'The gateway in front of model providers: a chat route, a token budget in Redis, SSE streams, failover, usage events.',
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 60,
  statement: `# LLM Gateway

Every product with a chat box grows the same service: one **gateway** that authenticates tenants,
holds them to a token budget, calls a model provider over gRPC, streams tokens back to the browser
and emits a usage event that billing can trust. Each piece is a few dozen lines, and each hides the
failure that costs money when two requests overlap, a tab closes or a broker stalls.

## The real system

LiteLLM's proxy is the open-source version of this gateway: it issues virtual keys with a
\`max_budget\`, \`tpm_limit\` and \`rpm_limit\`, tracks spend per key in its database, and since
v1.92 can reroute a request to a fallback model when a key's \`model_max_budget\` is exceeded instead
of answering \`budget_exceeded\`. Commercial gateways (Cloudflare AI Gateway, Portkey) add caching,
observability and provider routing on the same shape: a request contract, a budget, a provider
call, a stream, an event.

## What you build here

One service, **gateway**, every step a file of its own, the provided \`gateway/auth\` and
\`gateway/outbox\` modules shared by all of them:

1. \`POST /v1/chat\` (\`chat_api\`): body \`{model, messages, max_tokens}\`, tenant from
   \`Authorization: Bearer <tenant>\`, one \`Provider.Complete\` call with an 8 s deadline, answer
   \`{id, content, usage}\` with the provider's own token counts.
2. A daily **token budget** (\`budget\`): a guard in front of the chat route that reserves
   \`ceil(chars / 4) + max_tokens\` from \`budget:{tenant}:{yyyymmdd}\` in one Lua script and answers
   429 with \`Retry-After\` and \`X-RateLimit-Remaining\`.
3. \`POST /v1/chat/stream\` (\`chat_stream\`): \`Provider.StreamComplete\` relayed as SSE, one
   \`data: {"delta": …}\` frame per token, a \`usage\` frame and \`[DONE]\` at the end, the upstream
   call cancelled when the client leaves.
4. **Failover** (\`failover\`): \`stream_with_failover(request, idempotency_key)\` over
   \`primary:9000\` and \`fallback:9000\`, one attempt each, an 8 s deadline per attempt, retries only
   on \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` and only before the first token, a breaker at
   \`circuit:{provider}\`.
5. **Usage events** (\`usage_events\`): \`emit_usage(event)\` produces one record per request to
   \`usage\`, keyed by tenant, from an idempotent \`acks=all\` producer whose delivery failures go to
   the outbox; \`run_billing()\` adds the tokens to \`usage:{tenant}:{day}\` and commits after.

## Left out on purpose

Model routing and prompt templates, provider SDK details, key vaulting, real tokenisers (the
gateway estimates four characters per token) and the warehouse behind billing. Each slots into
the request path above without changing its shape.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'POST /v1/chat · /v1/chat/stream', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'gateway', sub: ':8443', x: 30, y: 50},
      {id: 'budget', kind: 'redis', label: 'Redis', sub: 'budget:{tenant}:{day} · circuit:{provider}', x: 52, y: 16},
      {id: 'providers', kind: 'grpc', label: 'Provider', sub: 'primary · fallback', x: 52, y: 50},
      {id: 'usage', kind: 'kafka', label: 'usage', sub: 'key = tenant', x: 74, y: 50},
      {id: 'billing', kind: 'service', label: 'billing', sub: 'consumer group', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'JSON · SSE'},
      {from: 'gateway', to: 'budget', kind: 'redis', label: 'EVAL reserve · INCR circuit'},
      {from: 'gateway', to: 'providers', kind: 'grpc', label: 'Complete · StreamComplete'},
      {from: 'gateway', to: 'usage', kind: 'kafka', label: 'produce (outbox on failure)'},
      {from: 'usage', to: 'billing', kind: 'kafka', label: 'consume'},
      {from: 'billing', to: 'budget', kind: 'redis', label: 'HINCRBY usage:{tenant}:{day}'},
    ],
  },
  steps: [chatEndpointStep, tenantBudgetStep, streamingCancelStep, providerFailoverStep, usageEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
