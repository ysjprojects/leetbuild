import {ANTHROPIC} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {researchEndpointStep} from './steps/1-research-endpoint';
import {subagentFanoutStep} from './steps/2-subagent-fanout';
import {checkpointsStep} from './steps/3-checkpoints';
import {toolCallsStep} from './steps/4-tool-calls';
import {traceEventsStep} from './steps/5-trace-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Anthropic's multi-agent Research system, rebuilt as the orchestration layer around the models:
 * a research job endpoint whose effort level fixes the budget → a lead agent that fans out to
 * subagents in parallel under deadlines and keeps their condensed findings → checkpoints and an
 * atomic tool-call reservation in Redis so a crashed lead resumes instead of restarting → tool calls
 * with a deadline, bounded backoff, untrusted results and literal citations → a trace topic without
 * content and an end-state evaluation consumer that writes before it commits.
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
and hands the result to a citation agent. Its production chapter is about budgets, resuming instead
of restarting, and tracing without the conversation. LangGraph's checkpointers solve the same resume
problem, saving graph state after every step under a \`thread_id\`; its docs keep \`InMemorySaver\`
for experiments and point production at a database-backed saver such as \`PostgresSaver\`.

## From the source

*How we built our multi-agent research system* supplies step 1's budget table (one agent for a
fact, 2–4 subagents for a comparison, ten or more for deep research), step 2's task description
(objective, output format, tools, boundaries) and the finding that parallel subagents cut research
time by up to 90%. Its production chapter shapes steps 3 to 5. *Building effective agents* supplies
the bounded loop and the tool contract in step 4.

## What you build here

One service, **researchd**, on one job store (\`research.jobs\`, provided: the hash
\`research:{job_id}\` with the job's budget and version, \`research:idem:{tenant}:{key}\`,
\`research:queue\`, and the shared \`Task\` and \`Budget\` shapes) and one proto (\`Subagent.Run\`,
\`Tools.Call\`):

1. \`POST /v1/research\` and \`GET /v1/research/{job_id}\`: a budget from a server-side effort table,
   one job per tenant and \`Idempotency-Key\`, a **202** and an enqueued job id.
2. \`run_subagents(job_id, plan, budget)\`: \`Subagent.Run\` in parallel batches of at most **5**, cut
   to the budget, under a **120 s** deadline, keeping condensed findings.
3. Checkpoints: the plan in \`research:{job_id}\`, results in \`research:{job_id}:results\`, a Lua
   script reserving tool calls on \`research:{job_id}:tools\`, every key expiring **24 h** after its
   last write.
4. \`call_tool\` and \`verify_citations\`: a **30 s** deadline, **3** attempts with backoff, sanitised
   results, citations checked against the fetched text.
5. \`research.trace\` keyed by job with ids and numbers only, and the \`end-state-eval\` consumer that
   writes \`research:{job_id}:eval\` before it commits.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

The prompts, the model calls behind planning and synthesis, the judge model that scores a report
against a rubric, source-quality heuristics, human evaluation and the rainbow traffic shift itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'research · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'researchd API', sub: 'POST /v1/research', x: 22, y: 50},
      {id: 'lead', kind: 'service', label: 'Lead agent', sub: 'fan out · resume', x: 40, y: 40},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'research:{job} · results · tools', x: 40, y: 78},
      {id: 'subagent', kind: 'grpc', label: 'Subagents', sub: 'Subagent.Run · 120 s', x: 58, y: 20},
      {id: 'tools', kind: 'grpc', label: 'Tools', sub: 'Tools.Call · 30 s', x: 76, y: 20},
      {id: 'citation', kind: 'service', label: 'Citation pass', sub: 'literal spans only', x: 58, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'research.trace', sub: 'key = job', x: 58, y: 80},
      {id: 'evaluator', kind: 'service', label: 'End-state eval', sub: 'group end-state-eval', x: 80, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'job · idem key · research:queue'},
      {from: 'lead', to: 'subagent', kind: 'grpc', label: 'Run · batches of 5'},
      {from: 'subagent', to: 'tools', kind: 'grpc', label: 'Call · 3 attempts'},
      {from: 'lead', to: 'redis', kind: 'redis', label: 'checkpoints · reserve'},
      {from: 'lead', to: 'citation', kind: 'plain', label: 'report + sources'},
      {from: 'lead', to: 'kafka', kind: 'kafka', label: 'produce research.trace'},
      {from: 'kafka', to: 'evaluator', kind: 'kafka', label: 'consume'},
      {from: 'evaluator', to: 'redis', kind: 'redis', label: 'HSET research:{job}:eval'},
    ],
  },
  steps: [researchEndpointStep, subagentFanoutStep, checkpointsStep, toolCallsStep, traceEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
