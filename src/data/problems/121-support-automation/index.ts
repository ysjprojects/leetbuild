import {AIRBNB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {turnEndpointStep} from './steps/1-turn-endpoint';
import {contextManagementStep} from './steps/2-context-management';
import {reasoningLoopStep} from './steps/3-reasoning-loop';
import {guardrailsStep} from './steps/4-guardrails';
import {traceEventsStep} from './steps/5-trace-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Airbnb's Automation Platform v2: the platform a support assistant runs on, not the assistant. A
 * turn endpoint that takes the role from the verified principal and claims the idempotency key in one
 * SET NX → per-conversation context in Redis, trimmed and expiring in one MULTI, with declared profile
 * fields and cached retriever answers → the Chain of Thought loop with deadlines, six iterations, a
 * role-checked tool registry and keyed write tools → a guardrail gate running every guardrail in
 * parallel under one deadline, failing closed and escalating to a human → one span per call on
 * assistant.trace keyed by conversation, without the text, with an outbox and metrics before the
 * commit. The dependencies are deterministic stand-ins the harness serves over gRPC.
 */
export const supportAutomationProblem: Problem = {
  id: 'support-automation',
  title: 'Support Automation Platform',
  tagline:
    "The platform under Airbnb's support assistant: one guest question through Redis context, a bounded reasoning loop with a tool registry, a guardrail gate and a trace topic.",
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

*Automation Platform v2: Improving conversational AI at Airbnb* walks through one turn: the platform
collects context (chat history, user id, user role), asks the model, runs the tool the first response
asks for (the user's most recent reservation), saves the result into the context, asks again, and
returns and records the second response. It names the pieces this course builds: the **Chain of
Thought workflow** (prepare context, ask for reasoning, execute the tool, process the outcome, loop
until a result) with a **Tool Manager** that manages execution and adds retry and rate limiting;
**context management**, where a product statically declares the context it needs (a customer name)
or names a dynamic retriever (help articles for the question); the **Guardrails Framework**, reusable
guardrails executed in parallel, some LLM-backed for content moderation, some rule-backed to stop a
bad tool execution; and **LLM-oriented observability** with latency and token usage per interaction.
The post gives mechanisms, not numbers: every cap, TTL, deadline and limit here is this course's.

## What you build here

One service, **apv2**, five pieces sharing one contract: the \`apv2\` support package (\`config\`: the
dependencies' addresses, the topic, the key layout; \`auth\`, \`turns\`, \`workflow\`, \`handoff\`,
\`outbox\`) and \`support_automation.proto\`, whose four services the checks serve as stand-ins.

1. \`POST /v1/conversations/{conversation}/messages\` with \`{"text"}\`: the role from \`auth.verify\`,
   8 KiB of UTF-8, \`Idempotency-Key\` claimed with one \`SET NX\` (\`turns.claim\`), then
   \`workflow.enqueue\` and 202 \`{turn_id, status}\`.
2. **Context store**: \`ctx:{tenant}:{conversation}\`, \`{kind, text}\` items trimmed to 40 with a
   24-hour TTL in one \`MULTI\`; declared profile fields by \`HMGET\`; retriever answers cached five
   minutes.
3. **Chain of Thought loop** \`run_turn(store, turn)\`: \`Reason\` (5 s) and \`Invoke\` (3 s), six
   iterations, a tool registry checked against the turn's role, WRITE tools keyed
   \`{turn_id}:{iteration}\`.
4. **Guardrail gate** \`gate(turn, answer, articles)\`: relevance, groundedness and pii in parallel
   under one 2 s deadline; anything but PASS goes to \`handoff.escalate\`.
5. **\`assistant.trace\`**: one span per call keyed by conversation, without the text, an outbox
   filled from the delivery callback, \`metrics:{tenant}:{kind}:{name}\` counted before the commit.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change.

## Left out on purpose

Prompt store, playground, tool publishing, LLM adapters, the agent console and the outbox relay.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Guest · agent app', sub: 'POST …/messages', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'apv2 API', sub: 'HTTPS :8443', x: 22, y: 50},
      {
        id: 'db',
        kind: 'redis',
        label: 'Turns · handoff · outbox',
        sub: 'turn:{conversation}:{key} · apv2:*',
        x: 40,
        y: 10,
      },
      {id: 'redis', kind: 'redis', label: 'Context · metrics', sub: 'ctx:{tenant}:{conversation}', x: 40, y: 36},
      {id: 'workflow', kind: 'service', label: 'CoT workflow', sub: 'reason → tool → outcome', x: 40, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'assistant.trace', sub: 'key = conversation', x: 40, y: 90},
      {id: 'retriever', kind: 'grpc', label: 'Context Retriever', sub: 'Retrieve · cached 5 min', x: 62, y: 8},
      {id: 'llm', kind: 'grpc', label: 'LLM Adapter', sub: 'Reason · 5 s', x: 62, y: 28},
      {id: 'tools', kind: 'grpc', label: 'Tool Manager', sub: 'Invoke · 3 s', x: 62, y: 50},
      {id: 'guardrails', kind: 'grpc', label: 'Guardrail Framework', sub: 'Check · parallel · 2 s', x: 62, y: 72},
      {id: 'human', kind: 'external', label: 'Human agent', sub: 'apv2:handoff', x: 82, y: 72},
      {id: 'consumer', kind: 'service', label: 'Trace consumer', sub: 'group insights', x: 62, y: 94},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'redis', label: 'SET NX turn'},
      {from: 'api', to: 'workflow', kind: 'plain', label: 'enqueue turn'},
      {from: 'workflow', to: 'redis', kind: 'redis', label: 'MULTI RPUSH · LTRIM · EXPIRE'},
      {from: 'workflow', to: 'retriever', kind: 'grpc', label: 'Retrieve'},
      {from: 'workflow', to: 'llm', kind: 'grpc', label: 'Reason'},
      {from: 'workflow', to: 'tools', kind: 'grpc', label: 'Invoke'},
      {from: 'workflow', to: 'guardrails', kind: 'grpc', label: 'Check ×3'},
      {from: 'workflow', to: 'human', kind: 'plain', label: 'escalate on non-PASS'},
      {from: 'workflow', to: 'kafka', kind: 'kafka', label: 'produce span'},
      {from: 'workflow', to: 'db', kind: 'redis', label: 'outbox on refusal'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY metrics'},
    ],
  },
  steps: [turnEndpointStep, contextManagementStep, reasoningLoopStep, guardrailsStep, traceEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
