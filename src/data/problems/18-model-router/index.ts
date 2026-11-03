import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {routeEndpointStep} from './steps/1-route-endpoint';
import {tenantLimitsStep} from './steps/2-tenant-limits';
import {modelCallStep} from './steps/3-model-call';
import {feedbackEventsStep} from './steps/4-feedback-events';
import {rolloutStep} from './steps/5-rollout';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Model router: the service that decides which model serves a request. Each step starts from a
 * starter that serves the demo and hides flaws the learner debugs: a caller who picks the model
 * by naming it, a per-minute limit that overspends under concurrency, a retry loop that cannot
 * stop or fall back, a feedback event that leaks the prompt or vanishes, and a canary rollout
 * that ignores its eval gate and overwrites a rollback.
 */
export const modelRouterProblem: Problem = {
  id: 'model-router',
  title: 'Model Router',
  tagline:
    'A router between a small and a large model: server-side model choice, a Redis rate window, retries with a fallback, feedback events, eval-gated canaries.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Model Router

A model router sits between product code and two models: \`gpt-4o-mini\`, cheap and fast, and
\`gpt-4o\`, slower and better. It decides which one serves a request, holds each tenant to a
per-minute budget, survives a deployment that stops answering, turns user feedback into quality
numbers per model, and moves a new routing policy to production a slice of traffic at a time.

## The real system

LiteLLM's \`Router\` is an open-source router of this shape: \`model_list\` names the deployments
behind each model group, \`num_retries\` retries a failed call, \`fallbacks\` names the group tried
once the retries are spent, and \`allowed_fails\` with \`cooldown_time\` takes a deployment out of
rotation after too many failures in a minute, which is the circuit breaker of step 3.

## What you build here

One service, **routerd**, every step a file of its own, the provided \`routerd/auth\`
(\`Authorization: Bearer <tenant>\`), \`routerd/tokens\` (\`estimate_tokens(prompt, max_tokens)\` =
\`ceil(UTF-8 bytes / 4) + max_tokens\`) and \`routerd/outbox\` modules shared by all of them:

1. \`POST /v1/route\` (\`router_api\`): body \`{prompt, max_tokens, policy}\`, policy \`auto\`,
   \`small\` or \`large\`, answer \`{id, model, policy, estimated_tokens}\`, the decision stored once
   per \`Idempotency-Key\` at \`decision:{tenant}:{key}\`.
2. A **rate window** (\`limits\`): a guard in front of the route that reserves one request and the
   estimate from \`limits:{tenant}:{minute}\` (hash fields \`requests\`, \`tokens\`; 60 requests and
   100 000 tokens) in one Lua script, and answers 429 with \`Retry-After\` and
   \`X-RateLimit-Remaining\`.
3. **The model call** (\`model_call\`): \`complete(model, prompt, max_tokens)\` calls
   \`Model.Complete\` at \`{model}:9000\`, 800 ms per attempt, three attempts on \`UNAVAILABLE\` or
   \`DEADLINE_EXCEEDED\`, then \`gpt-4o-mini\` as the fallback, with a breaker at \`circuit:{model}\`.
4. **Feedback events** (\`feedback\`): \`emit_feedback(event)\` produces
   \`{id, tenant, policy, model, outcome, latency_ms}\` to \`route.feedback\` keyed by tenant, the
   outbox \`outbox:feedback\` taking what the broker refuses; \`run_quality()\` counts outcomes in
   \`quality:{tenant}:{model}\` and commits after.
5. \`POST /v1/policies/{policy}/rollout\` (\`rollout\`): body \`{version, percentage}\` on the hash
   \`rollout:{policy}\` (\`stable\`, \`canary\`, \`percentage\`), gated by the eval record
   \`eval:{policy}:{version}\` (\`status\`, \`score\`).

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Provider accounts and keys, real tokenisers, streaming, how a request is assigned to the canary
share, the eval runner itself, and invoicing. Each plugs into the shapes above without changing
them.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'route · rollout', x: 8, y: 50},
      {id: 'router', kind: 'http', label: 'routerd', sub: ':8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'decision · limits · circuit · rollout', x: 50, y: 14},
      {id: 'large', kind: 'grpc', label: 'gpt-4o', sub: 'gpt-4o:9000', x: 52, y: 44},
      {id: 'small', kind: 'grpc', label: 'gpt-4o-mini', sub: 'fallback · :9000', x: 52, y: 66},
      {id: 'kafka', kind: 'kafka', label: 'route.feedback', sub: 'key = tenant', x: 74, y: 86},
      {id: 'quality', kind: 'service', label: 'quality', sub: 'consumer group', x: 92, y: 86},
      {id: 'eval', kind: 'service', label: 'eval service', sub: 'eval:{policy}:{version}', x: 78, y: 14},
    ],
    edges: [
      {from: 'client', to: 'router', kind: 'http', label: 'JSON'},
      {from: 'router', to: 'redis', kind: 'redis', label: 'SET NX · EVAL · INCR · HSET'},
      {from: 'router', to: 'large', kind: 'grpc', label: 'Complete · 800 ms'},
      {from: 'router', to: 'small', kind: 'grpc', label: 'fallback'},
      {from: 'router', to: 'kafka', kind: 'kafka', label: 'produce (outbox on failure)'},
      {from: 'kafka', to: 'quality', kind: 'kafka', label: 'consume'},
      {from: 'quality', to: 'redis', kind: 'redis', label: 'HINCRBY quality:{tenant}:{model}'},
      {from: 'eval', to: 'redis', kind: 'redis', label: 'HSET eval record'},
    ],
  },
  steps: [routeEndpointStep, tenantLimitsStep, modelCallStep, feedbackEventsStep, rolloutStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
