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
    'Run a lead agent over parallel subagents with effort budgets, checkpoints, bounded tool calls, literal citations and rainbow deployments — reviewed like production.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  track: 'ai',
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

A customer asks for every board member of every company in a 500-name index. One agent with one
context window searches sequentially, runs out of room and gives up. A lead agent that splits the
question across ten subagents, each with its own context, finds the answer in minutes — and spends
fifteen times the tokens of a chat doing it. You own the service that decides when that spend is
worth it, keeps it bounded, survives a crash halfway through, and can prove every citation in the
report points at text that was actually fetched.

## The real system

Anthropic's **Research** feature is an orchestrator–worker system: a lead agent reads the query,
plans, and spawns subagents that search in parallel with their own context windows; each subagent
condenses what it found, the lead synthesises the findings and decides whether to spawn more, and a
final citation agent attaches every claim to a source. The part that made it a product is not the
prompt. It is the budget that scales with the query, the task descriptions precise enough that
subagents do not duplicate each other, the checkpoints that let a long-running stateful agent resume
instead of restart, the tracing that explains a bad answer without reading the conversation, and the
deployment scheme that lets a new version ship while hundreds of agents are mid-task.

## From the source

*How we built our multi-agent research system* is the blueprint for this course. It describes the
orchestrator–worker architecture — a LeadResearcher that saves its plan to memory, creates
subagents with specific tasks, synthesises their results, loops until it has enough and then hands
everything to a CitationAgent — and is candid about the cost: agents use about four times the tokens
of a chat, multi-agent systems about fifteen times, so the pattern only pays for high-value tasks.
Its effort-scaling rules are the budget table in step 1: simple fact-finding gets one agent and
3–10 tool calls, a direct comparison 2–4 subagents with 10–15 calls each, complex research more than
ten subagents. Its lesson on delegation — every subagent needs an objective, an output format,
guidance on tools and sources, and clear boundaries, or agents duplicate work and leave gaps — is
the task spec in step 2, as is the finding that spinning up 3–5 subagents in parallel instead of
serially cut research time by up to 90%. The production chapter gives steps 3 to 5 their shape:
agents are stateful and errors compound, so the system resumes from where the agent was instead of
restarting, combining the model's adaptability with retry logic and regular checkpoints; full
production tracing of agent decision patterns, without the contents of individual conversations;
and rainbow deployments that keep old and new versions running together so a deploy never breaks
an agent mid-process. Its evaluation section — an LLM judge scoring factual accuracy, citation
accuracy, completeness, source quality and tool efficiency from 0.0 to 1.0 with a pass/fail grade,
and end-state evaluation that judges the final state rather than the path — is the consumer in
step 5.

*Building effective agents* supplies the vocabulary and the loop. It separates workflows (code
decides the path) from agents (the model decides), names the orchestrator-workers pattern this
course implements, describes the agent loop that takes ground truth from tool results and stops on
a maximum number of iterations, and insists that the agent–computer interface — tool definitions
with examples, edge cases and clear boundaries from other tools — deserves as much engineering as
the prompt. Step 4's tool contract and the bounded loops everywhere are taken from it.

## What you build here

One service, **researchd**, with five pieces:

1. \`POST /v1/research\`: authenticated tenant, a query of at most **8 KiB**, an \`effort\` of
   \`fact\`, \`compare\` or \`deep\` that the server maps to a budget (max subagents, max tool
   calls, token budget — never caller-supplied), an \`Idempotency-Key\`, and a **202** with a job id
   that \`GET /v1/research/{id}\` reports on. The handler enqueues; it never researches inline.
2. The **lead agent**: a plan of subtasks, each carrying an objective, an output format, the tools
   to use and its boundaries, run through \`Subagent.Run\` in parallel batches of at most **5** and
   never more than the budget allows, each with a **120 s** deadline, and only the condensed
   \`findings\` (capped at **4 000** characters) carried into synthesis — never the transcript.
3. **Checkpoints** in Redis: the job record under \`research:{job_id}\`, each subagent result under
   \`research:{job_id}:results\`, both with a **24-hour** TTL, so a lead that crashes resumes with
   the pending tasks only; and tool calls reserved against \`max_tool_calls\` by one atomic Lua
   script before the tool is called.
4. **Tool calls**: a **30 s** deadline, at most **3** attempts with exponential backoff from
   **500 ms**, retried only on \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`; results treated as
   untrusted text with instruction-like lines stripped and counted; and a citation pass that keeps a
   citation only when its span is a literal substring of a fetched source.
5. A **Kafka** trace: one \`research.trace\` event per decision keyed by job id — ids, tool,
   latency, tokens, outcome, version, never content — from an idempotent producer; an end-state
   evaluation consumer that scores completed jobs against the five-part rubric, writes the scores
   and commits only afterwards; and a job record pinned to the version that started it so a rainbow
   deployment never moves an in-flight job to new code.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real agent
system: read the draft against the failure modes the source names — cost, duplicated work, lost
state, unbounded retries, text that is not a source — fix it, and prove the fix with checks that
fail on the draft and pass on your version.

## Left out on purpose

The prompts themselves, the model calls behind planning and synthesis, extended thinking, the
memory the lead writes its plan to, asynchronous subagent steering, source-quality heuristics,
human evaluation, the judge's calibration against human graders, and the rainbow traffic shift
itself. The five pieces above are the ones that decide whether a multi-agent system is affordable,
resumable, and trustworthy enough to put in front of a customer.`,
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
