import {AIRBNB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {turnEndpointStep} from './steps/1-turn-endpoint';
import {contextManagementStep} from './steps/2-context-management';
import {reasoningLoopStep} from './steps/3-reasoning-loop';
import {guardrailsStep} from './steps/4-guardrails';
import {traceEventsStep} from './steps/5-trace-events';

/**
 * Airbnb's Automation Platform v2 on the AI-era track: the platform a support assistant runs on,
 * not the assistant. A turn endpoint that takes the role from the verified principal and accepts
 * work idempotently → per-conversation context in Redis with declared static context, cached
 * dynamic retrievers, a size budget and a TTL → the Chain of Thought reasoning loop with a
 * deadline per LLM call, a bounded iteration count, a tool registry and keyed write tools → the
 * guardrails framework running every configured guardrail in parallel under one deadline and
 * handing failures to a human → one trace event per LLM/tool call keyed by conversation, with an
 * outbox and metrics written before the offset commit.
 */
export const supportAutomationProblem: Problem = {
  id: 'support-automation',
  title: 'Support Automation Platform',
  tagline:
    "Airbnb's Automation Platform v2: a Chain of Thought reasoning loop with a tool registry, declared context in Redis, parallel guardrails that escalate to a human, and a trace per model call — reviewed like production.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 60,
  company: AIRBNB,
  sources: [
    {
      title: 'Automation Platform v2: Improving conversational AI at Airbnb',
      url: 'https://medium.com/airbnb-engineering/automation-platform-v2-improving-conversational-ai-at-airbnb-d86c9386e0cb',
      by: 'Chutian Wang, Zhiheng Xu, Paul Lou, Ziyi Wang, Jiayu Lou, Liuming Zhang, Jingwen Qiang, Clint Kelly, Lei Shi, Dan Zhao, Xu Hu, Jianqi Liao, Zecheng Xu, Tong Chen',
      date: '2024-10-28',
      takes:
        'The whole shape of the platform: the Chain of Thought workflow (prepare context, ask the LLM for reasoning, execute the requested tool, process its outcome, loop until a result) with its CoT IO handler, Tool Manager and LLM Adapter; context management where a product statically declares the context it needs or names a dynamic context retriever, served by a Context Loader and a Runtime Context Manager; the Guardrails Framework of reusable guardrails executed in parallel, LLM-backed for content moderation and rule-backed for tool execution; and LLM-oriented observability recording latency and token usage per interaction. The post gives no caps or deadlines, so every number here is ours.',
    },
  ],
  statement: `# Support Automation Platform

A guest asks the support assistant where their next reservation is. The model cannot know; it has to
ask the platform to fetch the reservation, read the result, and only then answer. You own the
platform in between: the thing that decides what context the model sees, which tools it may call,
how many times it may think, what happens when a guardrail says no, and what gets recorded when a
turn costs more than it should.

## The real system

Airbnb's **Automation Platform** started as a workflow engine for conversational products: every
support flow was a predefined, step-by-step workflow that product teams designed by hand. Version 2
keeps those workflows and adds an LLM runtime around them. A **Chain of Thought workflow** uses the
model as the reasoning engine that decides which tools to run and in which order; tools are the
same actions and workflows v1 already ran, now behind a unified interface and a managed execution
environment. **Context management** lets a product declare the context it needs instead of dumping
everything it has. A **Guardrails Framework** runs reusable guardrails against what the model says
and what it wants to do. **Observability** records latency and token usage for every LLM
interaction. And the sensitive flows — claims, anything with strict validation — stay on
traditional workflows, because an LLM is not yet predictable enough for them.

## From the source

*Automation Platform v2: Improving conversational AI at Airbnb* walks through one turn: an inquiry
arrives, the platform collects context (chat history, user id, user role), assembles the prompt,
and sends it to the model; the first response asks for a tool that fetches the user's most recent
reservation; the platform runs the call, saves the response into the context, sends the updated
context back, and the second response is the answer, which is returned and recorded. The post
names the pieces this course builds. The **Chain of Thought workflow** (prepare context → ask the
LLM for reasoning → tool or result → execute the tool → process the outcome → loop until a result)
with its **CoT IO handler**, a **Tool Manager** that prepares tool payloads, manages execution and
adds retry and rate limiting, and an **LLM Adapter** per model type. **Context management**, where
developers either statically declare the context they need (a customer name) or name a dynamic
context retriever (help articles relevant to the question), served by a **Context Loader** and a
**Runtime Context Manager** that keeps runtime context per LLM call and talks to context storage.
The **Guardrails Framework**, built because of hallucinations and jailbreaks: reusable guardrails
from different teams, executed in parallel, some calling LLMs for content moderation and some
applying rules to stop a bad tool execution such as updating a listing with an invalid setup. And
**LLM-oriented observability** with latency and token usage per interaction, plus tool management
covering registration, publishing, execution and observability. The post gives mechanisms and
vocabulary, not numbers: the caps, TTLs, deadlines and iteration limits below are this course's.

## What you build here

One service, **apv2**, with five pieces:

1. \`POST /v1/conversations/{id}/messages\`: the actor and role come from the verified bearer
   token (**401** otherwise), never from the body; a non-empty \`text\` of at most **8 KiB**
   (**413** above); a required \`Idempotency-Key\` so a client retry returns the same turn; the
   turn is enqueued for the workflow and answered with **202** and a \`turn_id\`.
2. **Context management** in Redis: the conversation's runtime context under
   \`ctx:{tenant}:{conversation}\`, at most **40** items, a **24-hour** TTL refreshed on write,
   appended and trimmed in one transaction; static context loaded only for the keys the product
   declares; dynamic retrievers fetched per turn and cached for **5 minutes**, never written into
   the conversation.
3. The **Chain of Thought loop** over gRPC: \`Reason\` on the LLM Adapter with a **5 s** deadline,
   at most **6** iterations, tools resolved through a registry (an unknown name is an outcome fed
   back to the model, never a call), \`Invoke\` on the Tool Manager with a **3 s** deadline, and
   write tools keyed by \`{turn}:{iteration}\` so a retry cannot apply the same change twice.
4. The **guardrails framework**: \`relevance\`, \`groundedness\` and \`pii\` run in parallel under
   one **2 s** deadline; a timeout is a failed verdict; any failed verdict blocks the answer and
   hands the conversation to a human agent with the verdicts attached.
5. **Observability** on Kafka: one \`assistant.trace\` event per LLM or tool call, keyed by
   conversation, carrying ids, latency, token counts and guardrail verdicts and never message
   text; an idempotent producer with \`acks=all\`; an outbox row when the broker rejects; a consumer
   that updates the Redis metrics before it commits.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

The prompt store and prompt editor, the playground, point-in-time context for offline evaluation,
tool registration and publishing, the LLM adapters themselves, the traditional workflows that
sensitive flows still run on, and the human agent's console. The five pieces above are the ones
that decide whether an LLM-driven support turn is bounded, grounded, safe to act on and
accountable afterwards.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Guest · agent app', sub: 'POST …/messages', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'apv2 API', sub: 'HTTPS :8443', x: 22, y: 50},
      {id: 'db', kind: 'db', label: 'turns · outbox', sub: 'idempotency · relay', x: 40, y: 10},
      {id: 'redis', kind: 'redis', label: 'Context store', sub: 'ctx:{tenant}:{conversation}', x: 40, y: 36},
      {id: 'workflow', kind: 'service', label: 'CoT workflow', sub: 'reason → tool → outcome', x: 40, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'assistant.trace', sub: 'key = conversation', x: 40, y: 90},
      {id: 'llm', kind: 'grpc', label: 'LLM Adapter', sub: 'Reason · 5 s', x: 62, y: 28},
      {id: 'tools', kind: 'grpc', label: 'Tool Manager', sub: 'Invoke · 3 s', x: 62, y: 50},
      {id: 'guardrails', kind: 'grpc', label: 'Guardrail Framework', sub: 'Check · parallel · 2 s', x: 62, y: 72},
      {id: 'human', kind: 'external', label: 'Human agent', sub: 'escalation queue', x: 82, y: 72},
      {id: 'consumer', kind: 'service', label: 'Trace consumer', sub: 'group insights', x: 62, y: 94},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'turns'},
      {from: 'api', to: 'workflow', kind: 'plain', label: 'enqueue turn'},
      {from: 'workflow', to: 'redis', kind: 'redis', label: 'RPUSH · LTRIM · EXPIRE'},
      {from: 'workflow', to: 'llm', kind: 'grpc', label: 'Reason'},
      {from: 'workflow', to: 'tools', kind: 'grpc', label: 'Invoke'},
      {from: 'workflow', to: 'guardrails', kind: 'grpc', label: 'Check ×3'},
      {from: 'guardrails', to: 'human', kind: 'plain', label: 'escalate on FAIL'},
      {from: 'workflow', to: 'kafka', kind: 'kafka', label: 'produce assistant.trace'},
      {from: 'workflow', to: 'db', kind: 'plain', label: 'outbox on reject'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY metrics'},
    ],
  },
  steps: [turnEndpointStep, contextManagementStep, reasoningLoopStep, guardrailsStep, traceEventsStep],
};
