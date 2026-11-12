import {SHOPIFY} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {assistEndpointStep} from './steps/1-assist-endpoint';
import {agentLoopStep} from './steps/2-agent-loop';
import {merchantBudgetStep} from './steps/3-merchant-budget';
import {judgeGateStep} from './steps/4-judge-gate';
import {assistTraceStep} from './steps/5-assist-trace';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Shopify's Sidekick, rebuilt as the system around one agent: an assist endpoint whose shop and
 * scopes come from the server → the agent loop with a constant system prompt, just-in-time tool
 * instructions, a turn cap, deadlines and a scope gate → a per-shop budget in one Lua script, a
 * shop-scoped tool cache and write tools claimed once → a release gate of per-criterion judges
 * calibrated against human labels, schema first → shop-keyed traces without merchant data feeding
 * the ground-truth set. The model, the tools and the judges are deterministic stand-ins the checks
 * serve over gRPC.
 */
export const merchantAgentProblem: Problem = {
  id: 'merchant-agent',
  title: 'Merchant Assistant',
  tagline: "Shopify's Sidekick around one agent loop, from the assist endpoint to the judges that gate a release.",
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  tag: 'ai-systems',
  minutes: 75,
  company: SHOPIFY,
  sources: [
    {
      title: 'Building production-ready agentic systems: Lessons from Shopify Sidekick',
      url: 'https://shopify.engineering/building-production-ready-agentic-systems',
      by: 'Andrew McNamara, Ben Lafferty, Michael Garner',
      date: '2025-08-26',
      takes:
        'The whole shape of the course: the agentic loop behind a merchant assistant; the tool-complexity problem (clear up to 20 tools, blurred boundaries at 20–50, several ways to do everything past 50) and the "death by a thousand instructions" system prompt it produces; just-in-time instructions returned alongside tool data so the core prompt stays stable and cacheable; evaluation on ground-truth sets sampled from real conversations, LLM judges per criterion calibrated against at least three human labellers with Cohen\'s kappa (0.02 → 0.61 against a human ceiling of 0.69), and procedural schema validation in front of the semantic judge to catch tag-hacking filters.',
    },
  ],
  statement: `# Merchant Assistant

A merchant on the customers page asks "which of my customers are from Toronto?", then "write an SEO
description for the jacket I have open". One model in a loop over a catalog of tools answers both.
Whether that is safe to ship depends on the code around the model: whose shop the turn is for, what
the loop sends and allows, what a shop may spend, and whether the release gate measures anything.

## The real system

Shopify's **Sidekick** is the assistant inside the Shopify admin. Shopify's help center describes it
working with the store's data and presenting changes for the merchant to review before they are
applied: it segments customers, writes product copy and answers analytics questions.

## From the source

*Building production-ready agentic systems: Lessons from Shopify Sidekick* (Shopify Engineering)
gives this course its mechanisms. Up to about 20 tools the boundaries are clear; past 50 there are
several ways to do everything, and the system prompt fills with special cases, *death by a thousand
instructions*. The fix is **just-in-time instructions**: a tool's guidance comes back with its data,
only when the tool is in play, so the core prompt stays stable and cacheable. For evaluation the team
samples real conversations into **ground-truth sets** labelled by at least three experts, and calibrates
one **LLM judge** per criterion until Cohen's kappa against the humans rose from 0.02 to 0.61 (the
humans agree at 0.69). During reinforcement learning the model gamed its reward with filters like
\`customer_tags CONTAINS 'enabled'\`; schema validation in front of the judge catches that. Caps,
deadlines and TTLs here are this course's own.

## What you build here

One service, **sidekick**, on the provided \`sidekick\` package and the \`sidekickrpc\` proto (\`Model\`,
\`Tools\`, \`Judge\`), whose peers the checks serve as deterministic stand-ins:

1. \`POST /v1/assist\`: shop from \`X-Shop-Id\`, an 8 KiB cap, a page whitelist, \`Idempotency-Key\`
   against \`turn:{shop}:{key}\`, scopes from \`perms:{shop}\`, then \`run_agent\`.
2. \`run_agent(shop, scopes, message, page, turn_id)\`: a constant system prompt, just-in-time
   instructions, 6 turns, 10 s per model call, 30 s per loop, a scope gate.
3. \`reserve\`: one Lua script over \`budget:{shop}:{window}\`; \`invoke_tool\`: a 120 s read cache per
   shop, writes once per turn.
4. \`gate(version)\`: 200 conversations, a judge per criterion, kappa of at least 0.6, schema first,
   a floor and a regression limit.
5. \`publish(turn)\` on \`assist.trace\` keyed by shop, ids and counts only, an outbox on refusal; the
   \`gtx-builder\` inserts, then commits.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

The model and the judges themselves, the admin's tools, reinforcement learning, the merchant
simulator, instruction variants and streaming the answer.`,
  diagram: {
    nodes: [
      {id: 'merchant', kind: 'client', label: 'Shopify admin', sub: 'POST /v1/assist', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'sidekick', sub: 'assist · loop · gate · trace', x: 24, y: 50},
      {id: 'turns', kind: 'db', label: 'turns · permissions', sub: 'turn:{shop}:{key} · perms:{shop}', x: 44, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'budget · tool cache · write claims', x: 44, y: 36},
      {id: 'kafka', kind: 'kafka', label: 'assist.trace', sub: 'key = shop', x: 44, y: 92},
      {id: 'model', kind: 'grpc', label: 'Model', sub: 'Complete · 10 s', x: 66, y: 8},
      {id: 'tools', kind: 'grpc', label: 'Tools', sub: 'Invoke · segment · fill form', x: 66, y: 36},
      {id: 'judge', kind: 'grpc', label: 'Judge', sub: 'Score per criterion · 15 s', x: 66, y: 64},
      {id: 'gtx', kind: 'db', label: 'ground-truth set', sub: 'samples · labels · baseline', x: 88, y: 64},
      {id: 'builder', kind: 'service', label: 'gtx-builder', sub: 'group gtx-builder', x: 66, y: 92},
    ],
    edges: [
      {from: 'merchant', to: 'api', kind: 'http', label: 'X-Shop-Id · Idempotency-Key'},
      {from: 'api', to: 'turns', kind: 'plain', label: 'get · put · scopes_for'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA reserve · GET/SET EX · SET NX'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Complete'},
      {from: 'api', to: 'tools', kind: 'grpc', label: 'Invoke'},
      {from: 'api', to: 'judge', kind: 'grpc', label: 'Score (release gate)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce · outbox on refusal'},
      {from: 'kafka', to: 'builder', kind: 'kafka', label: 'consume'},
      {from: 'builder', to: 'gtx', kind: 'plain', label: 'insert_candidate, then commit'},
      {from: 'judge', to: 'gtx', kind: 'plain', label: 'sample · baseline · record'},
    ],
  },
  steps: [assistEndpointStep, agentLoopStep, merchantBudgetStep, judgeGateStep, assistTraceStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
