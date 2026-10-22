import {SHOPIFY} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {assistEndpointStep} from './steps/1-assist-endpoint';
import {agentLoopStep} from './steps/2-agent-loop';
import {merchantBudgetStep} from './steps/3-merchant-budget';
import {judgeGateStep} from './steps/4-judge-gate';
import {assistTraceStep} from './steps/5-assist-trace';

/**
 * Shopify's Sidekick, rebuilt as the system around one agent on the AI-era track: an assist
 * endpoint whose shop and permission set come from the server → the agentic loop with a constant
 * system prompt, a compact tool list and just-in-time instructions, bounded by turns and deadlines →
 * a per-shop budget, a shop-scoped tool cache and write tools claimed once → a release gate of
 * per-criterion judges calibrated against human labels over a ground-truth sample → shop-keyed
 * trace events with no merchant data feeding the ground-truth set.
 */
export const merchantAgentProblem: Problem = {
  id: 'merchant-agent',
  title: 'Merchant Assistant',
  tagline:
    "Shopify's Sidekick as a reviewable system: just-in-time tool instructions, bounded agentic turns, per-shop budgets, and judges calibrated against humans before a prompt ships.",
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  track: 'ai',
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

A merchant on the customers page types "which of my customers are from Toronto?" and, a moment
later, "write an SEO description for the jacket I have open". The assistant that answers is one
model in a loop with a few dozen tools, running inside the admin of a million shops. What decides
whether it is safe to ship is not the model: it is the handler that refuses to take the shop from
the body, the loop that gives the model exactly the guidance it needs and not a token more, the
budget and cache that keep one merchant's spend and data inside that merchant, and the judges that
have earned the right to gate a release.

## The real system

Shopify's **Sidekick** is an AI assistant inside the Shopify admin: it segments customers, fills
product forms, answers analytics questions and navigates the admin on the merchant's behalf. It is
built on the agentic loop — a merchant writes, the model decides on an action, the action runs
against the shop, the result feeds the next decision — and it grew from a handful of tools to
dozens. That growth is where the engineering lessons come from: a system prompt that tried to
cover every tool's special cases became impossible to maintain, and "it looks fine in the demo"
turned out to be no evidence at all once prompts, models and tools changed every week.

## From the source

*Building production-ready agentic systems: Lessons from Shopify Sidekick* (Shopify Engineering,
based on the team's ICML 2025 talk) gives this course its mechanisms. On architecture: with up to
about 20 tools the boundaries are clear; between 20 and 50 they blur and tool combinations start
producing surprises; past 50 there are several ways to accomplish the same task and the system is
hard to reason about. The symptom was a system prompt stuffed with special cases — *death by a
thousand instructions* — and the fix was **just-in-time instructions**: return a tool's guidance
alongside that tool's data, only when the tool is in play, so the core prompt covers fundamental
behaviour, prompt caches keep hitting, and guidance can vary by beta flag, model version or page.
The post's own advice is to stay simple, start modular, and avoid multi-agent architectures early —
this course is one agent, deliberately.

On evaluation the post is blunt: vibe testing, or a judge told to "rate this 0–10", ships a false
sense of security. Instead the team samples real merchant conversations into **ground-truth sets**,
has at least three product experts label them, measures inter-annotator agreement (Cohen's kappa,
Kendall's tau, Pearson) and treats human agreement as the ceiling a judge can reach. Their
**LLM judges** are specialised per aspect and calibrated by iterating on prompts until agreement
with humans rose from a kappa of 0.02 to 0.61 against a human baseline of 0.69. A merchant
simulator replays the goals of real conversations through candidate systems before deployment.
From the GRPO training section the course takes only the gated-reward idea: procedural validation
(syntax and schema) in front of the semantic judge, because the model learned to game rewards with
filters like \`customer_tags CONTAINS 'enabled'\` where \`customer_account_status = 'ENABLED'\` was
right — and the schema validators and judges had to be updated to catch it. The numbers in this
course — the tool-count bands, the kappa floor of 0.6, the three-labeller ground-truth set, the
schema-first gate — come from that post; the caps, deadlines and TTLs are this course's own.

## What you build here

One service, **sidekick**, with five pieces:

1. \`POST /v1/assist\`: the shop from the authenticated \`X-Shop-Id\` (**401** without it), an
   8 KiB message cap, a page-type whitelist, a required \`Idempotency-Key\` so a retry cannot run a
   form-filling tool twice, and the merchant's **permission set** attached server-side from the
   permission store — never from the body.
2. The **agentic loop** over \`Model.Complete\` and \`Tools.Invoke\`: a constant system prompt, a
   compact tool list (name and one line each), **just-in-time instructions** carried in the next
   model call only when a tool fired, at most **6** turns, a **10 s** deadline per call and a
   **30 s** budget per loop, and a scope gate that refuses tools outside the merchant's permissions.
3. A **Redis** spending layer: **30 requests** and **150 000 tokens** per shop per 60-second window
   reserved by one atomic Lua \`EVAL\` before the model call; a tool-result cache keyed
   \`tool:{shop}:{name}:{digest}\` with a 120 s TTL; write tools claimed once per turn with
   \`SET NX\` on \`write:{shop}:{turn_id}:{name}\`.
4. A **gRPC** release gate over \`Judge.Score\`: **200** conversations sampled from the ground-truth
   set, one judge per criterion with a rubric over the whole conversation, Cohen's kappa against
   human labels with a **0.6** floor before a judge is trusted, schema validation of every tool call
   before any judge runs, and a ship decision that needs **0.8** on every criterion and no more than
   **0.02** regression from the baseline.
5. A **Kafka** trace path: one \`assist.trace\` event per turn keyed by shop with ids, tools used,
   latency, tokens and the judge score — no merchant message, no tool results — from an idempotent
   \`acks=all\` producer with an outbox on failure, and a \`gtx-builder\` consumer that inserts the
   ground-truth candidate before it commits.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

The model and the judges themselves, the tool implementations against the admin's APIs, GRPO
training and reward design, the merchant simulator, instruction variants by beta flag and model
version, human labelling tooling, and streaming the answer to the admin. The five pieces above are
the ones that decide whether an assistant with write access to a merchant's store is correct,
isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'merchant', kind: 'client', label: 'Shopify admin', sub: 'POST /v1/assist', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'sidekick', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'turns', kind: 'db', label: 'turns · permissions', sub: 'idempotency · scopes · outbox', x: 44, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'budget · tool cache · write claims', x: 44, y: 36},
      {id: 'kafka', kind: 'kafka', label: 'assist.trace', sub: 'key = shop', x: 44, y: 92},
      {id: 'model', kind: 'grpc', label: 'Model', sub: 'Complete · JIT instructions', x: 66, y: 8},
      {id: 'tools', kind: 'grpc', label: 'Tools', sub: 'Invoke · segment · fill form', x: 66, y: 36},
      {id: 'judge', kind: 'grpc', label: 'Judge', sub: 'Score per criterion', x: 66, y: 64},
      {id: 'gtx', kind: 'db', label: 'ground-truth set', sub: 'labels · baselines', x: 88, y: 64},
      {id: 'builder', kind: 'service', label: 'gtx-builder', sub: 'group gtx-builder', x: 66, y: 92},
    ],
    edges: [
      {from: 'merchant', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'turns', kind: 'plain', label: 'turns · scopes · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL · GET/SET EX · SET NX'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Complete'},
      {from: 'api', to: 'tools', kind: 'grpc', label: 'Invoke'},
      {from: 'api', to: 'judge', kind: 'grpc', label: 'Score (release gate)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce assist.trace'},
      {from: 'kafka', to: 'builder', kind: 'kafka', label: 'consume'},
      {from: 'builder', to: 'gtx', kind: 'plain', label: 'insert_candidate'},
      {from: 'judge', to: 'gtx', kind: 'plain', label: 'labels · baseline'},
    ],
  },
  steps: [assistEndpointStep, agentLoopStep, merchantBudgetStep, judgeGateStep, assistTraceStep],
};
