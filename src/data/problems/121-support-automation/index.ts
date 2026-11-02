import {AIRBNB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {turnEndpointStep} from './steps/1-turn-endpoint';
import {contextManagementStep} from './steps/2-context-management';
import {reasoningLoopStep} from './steps/3-reasoning-loop';
import {guardrailsStep} from './steps/4-guardrails';
import {traceEventsStep} from './steps/5-trace-events';

/**
 * Airbnb's Automation Platform v2: the platform a support assistant runs on, not the assistant. A
 * turn endpoint that takes the role from the verified principal and accepts work idempotently →
 * per-conversation context in Redis with declared static context, cached dynamic retrievers, a
 * size budget and a TTL → the Chain of Thought reasoning loop with a deadline per LLM call, a
 * bounded iteration count, a tool registry and keyed write tools → the guardrails framework
 * running every configured guardrail in parallel under one deadline and handing failures to a
 * human → one trace event per LLM/tool call keyed by conversation, with an outbox and metrics
 * written before the offset commit.
 */
export const supportAutomationProblem: Problem = {
  id: 'support-automation',
  title: 'Support Automation Platform',
  tagline:
    "Airbnb's Automation Platform v2: a Chain of Thought reasoning loop with a tool registry, declared context in Redis, parallel guardrails that escalate to a human, and a trace per model call.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
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

A guest asks where their next reservation is. The model asks the platform to fetch it, then
answers. You own the platform in between.

## The real system

Airbnb's **Automation Platform v2** wraps an LLM runtime around its v1 workflow engine; its
Guardrails Framework runs reusable guardrails in parallel, including tool guardrails that block
updating a listing with an invalid configuration.

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

One service, **apv2**: the turn endpoint (verified role, 8 KiB cap, \`Idempotency-Key\`, 202);
the Redis context store (40 items, 24-hour TTL, declared context, cached retrievers); the
reasoning loop (deadlines, 6 iterations, tool registry, keyed writes); the guardrail gate (parallel,
2 s, fail closed, escalate); the trace topic (keyed by conversation, outbox, metrics before commit).

## The debugging habit

Each starter serves the happy path. Debug it, fix it, prove it.

## Left out on purpose

Prompt store, playground, tool publishing, LLM adapters, agent console.`,
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
