import {ANTHROPIC} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {researchEndpointStep} from './steps/1-research-endpoint';
import {subagentFanoutStep} from './steps/2-subagent-fanout';
import {checkpointsStep} from './steps/3-checkpoints';
import {toolCallsStep} from './steps/4-tool-calls';
import {traceEventsStep} from './steps/5-trace-events';

/**
 * Anthropic's multi-agent Research system, rebuilt as the orchestration layer around the models:
 * a research job endpoint whose effort level fixes the budget → a lead agent that fans out to
 * subagents in parallel under deadlines and condenses what comes back → checkpoints and atomic
 * tool-call counters in Redis so a crashed lead resumes instead of restarting → tool calls with
 * deadlines, bounded backoff, untrusted results and literal citations → a trace topic without
 * content, an end-state evaluation consumer with a rubric, and jobs pinned to the version that
 * started them.
 */
export const researchOrchestratorProblem: Problem = {
  id: 'research-orchestrator',
  title: 'Research Orchestrator',
  tagline:
    'Debug the lead agent that fans a research query out to subagents under an effort budget and resumes from Redis checkpoints after a crash.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  tag: 'ai-systems',
  minutes: 75,
  company: ANTHROPIC,
  sources: [
    {
      title: 'How we built our multi-agent research system',
      url: 'https://www.anthropic.com/engineering/multi-agent-research-system',
      by: 'Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel Ford',
      date: '2025-06-13',
      takes:
        'The whole shape of the system: an orchestrator–worker pattern where a lead agent plans, spawns subagents with their own context windows in parallel and synthesises what they condense, then a citation agent; the cost figure (about 15× the tokens of a chat) and the effort-scaling rules (one agent and 3–10 tool calls for a fact, 2–4 subagents for a comparison, 10+ for complex research) that become the budget table; task descriptions with an objective, output format, tools and boundaries; parallel tool calls cutting research time by up to 90%; LLM-as-judge rubrics and end-state evaluation; and the production chapter — stateful agents whose errors compound, resume from checkpoints, retries, full tracing without conversation content, and rainbow deployments so running agents are not disrupted.',
    },
    {
      title: 'Building effective agents',
      url: 'https://www.anthropic.com/research/building-effective-agents',
      by: 'Erik S., Barry Zhang',
      date: '2024-12-19',
      takes:
        'The vocabulary: workflows versus agents, the orchestrator-workers pattern where a central model breaks a task down and synthesises worker results, the agentic loop that takes ground truth from tool results and stops on a maximum number of iterations, and the agent–computer interface — tool definitions with clear boundaries, tested as carefully as the prompt.',
    },
  ],
  statement: `# Research Orchestrator

One agent with one context window runs out of room on "every board member of every company in a
500-name index" and gives up. A lead agent that splits the question across ten subagents answers in
minutes and spends fifteen times the tokens of a chat. You own the service that keeps that spend
bounded, survives a crash halfway through, and can prove every citation points at fetched text.

## The real system

Anthropic's **Research** feature is an orchestrator-worker system: a lead agent plans, spawns
subagents that search in parallel with their own context windows, synthesises what they condense
and hands the result to a citation agent. What made it a product is the budget that scales with the
query, checkpoints that let a stateful agent resume instead of restart, tracing that explains a bad
answer without the conversation, and a rainbow deployment that ships a new version mid-task. The
resume problem is general: LangGraph's checkpointers save graph state after every step
under a \`thread_id\`, and its docs warn that \`InMemorySaver\` loses every checkpoint on restart, so
production uses \`PostgresSaver\`. Step 3 builds the same thing on Redis hashes.

## From the source

*How we built our multi-agent research system* supplies step 1's budget table (one agent for a
fact, 2–4 subagents for a comparison, ten or more for deep research), step 2's task description
(objective, output format, tools, boundaries) and the finding that parallel subagents cut research
time by up to 90%. Its production chapter shapes steps 3 to 5. *Building effective agents* supplies
the bounded loop and the tool contract in step 4.

## What you build here

One service, **researchd**: \`POST /v1/research\` with a server-side budget and a **202**; a lead
agent running \`Subagent.Run\` in parallel batches of **5** under a **120 s** deadline; checkpoints
under \`research:{job_id}\` with a **24-hour** TTL and a Lua script that reserves tool calls; tool
calls with a **30 s** deadline, **3** attempts, sanitised results and literal citations; and a
\`research.trace\` topic feeding an end-state evaluation consumer, with every job pinned to its
starting version.

## The debugging habit

Every starter compiles and serves the happy path. In every step you debug it against the failure
modes the source names, fix it, and prove the fix with checks that fail on the starter and pass on
yours.

## Left out on purpose

The prompts, the model calls behind planning and synthesis, source-quality heuristics, human
evaluation and the rainbow traffic shift itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'research · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'researchd API', sub: 'HTTPS :8443', x: 22, y: 50},
      {id: 'lead', kind: 'service', label: 'Lead agent', sub: 'plan · fan out · synthesise', x: 40, y: 40},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'research:{job} · budgets', x: 40, y: 78},
      {id: 'subagent', kind: 'grpc', label: 'Subagents', sub: 'Subagent.Run', x: 58, y: 20},
      {id: 'tools', kind: 'grpc', label: 'Tools', sub: 'Tools.Call · search / fetch', x: 76, y: 20},
      {id: 'citation', kind: 'service', label: 'Citation pass', sub: 'literal spans only', x: 58, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'research.trace', sub: 'key = job', x: 58, y: 80},
      {id: 'evaluator', kind: 'service', label: 'End-state eval', sub: 'group end-state-eval', x: 76, y: 80},
      {id: 'judge', kind: 'external', label: 'LLM judge', sub: 'rubric 0.0–1.0 · pass/fail', x: 92, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'lead', kind: 'plain', label: 'enqueue job'},
      {from: 'lead', to: 'subagent', kind: 'grpc', label: 'Run · deadline 120 s'},
      {from: 'subagent', to: 'tools', kind: 'grpc', label: 'Call · deadline 30 s'},
      {from: 'lead', to: 'redis', kind: 'redis', label: 'checkpoints · reserve'},
      {from: 'lead', to: 'citation', kind: 'plain', label: 'report + sources'},
      {from: 'lead', to: 'kafka', kind: 'kafka', label: 'produce research.trace'},
      {from: 'kafka', to: 'evaluator', kind: 'kafka', label: 'consume'},
      {from: 'evaluator', to: 'judge', kind: 'plain', label: 'score(job, rubric)'},
      {from: 'evaluator', to: 'redis', kind: 'redis', label: 'HSET research:{job}:eval'},
    ],
  },
  steps: [researchEndpointStep, subagentFanoutStep, checkpointsStep, toolCallsStep, traceEventsStep],
};
