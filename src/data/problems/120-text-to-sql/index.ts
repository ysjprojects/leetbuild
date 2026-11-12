import {UBER} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {queryEndpointStep} from './steps/1-query-endpoint';
import {decisionCacheStep} from './steps/2-decision-cache';
import {agentChainStep} from './steps/3-agent-chain';
import {runGuardStep} from './steps/4-run-guard';
import {feedbackEvalStep} from './steps/5-feedback-eval';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Uber's QueryGPT: not "ask a model for SQL", but the service around the agents that makes the
 * SQL safe to run. A validated, idempotent query endpoint that resolves a workspace and proposes
 * tables for the user's ACK → a Redis layer that caches decisions by workspace and normalised
 * question and reserves a per-user budget in one script → the agent chain under per-call deadlines
 * with column pruning before generation and defensively parsed output → a run endpoint that guards
 * generated SQL before the warehouse sees it → a feedback topic carrying the evaluation signals,
 * aggregated per workspace before the commit. The agents and the warehouse are deterministic
 * stand-ins the harness serves over gRPC.
 */
export const textToSqlProblem: Problem = {
  id: 'text-to-sql',
  title: 'Text-to-SQL',
  tagline:
    "Uber's QueryGPT: intent and table agents behind a guarded endpoint, with a run guard between generated SQL and the warehouse.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 60,
  company: UBER,
  sources: [
    {
      title: 'QueryGPT – Natural Language to SQL Using Generative AI',
      url: 'https://www.uber.com/blog/query-gpt/',
      by: 'Jeffrey Johnson, Callie Busch, Abhi Khune',
      date: '2024-09-19',
      takes:
        'The whole shape of the course: the first version’s kNN over schemas and SQL samples (3 tables, 7 samples) that lost accuracy as tables were added; workspaces as curated table-and-sample sets per domain (Mobility, Ads, Core Services and eight more system workspaces, plus custom ones); the intent agent that maps a question to workspaces, the table agent whose picks the user ACKs or edits, and the column prune agent that was added because wide tables cost 40–60K tokens and broke the model’s 32K limit; SQL plus explanation as the output; and the evaluation signals — intent accuracy, table overlap, successful run, run-has-output, LLM-judged similarity — with the vanilla and decoupled flows and the hallucinated-filter and missing-partition-filter failures.',
    },
  ],
  statement: `# Text-to-SQL

A model writes SQL in seconds; whether it names a real table, filters on the partition column and is
safe to run is decided by the service around it.

## The real system

Uber's **QueryGPT** answers questions with SQL over hundreds of thousands of datasets: an **intent
agent** picks **workspaces**, the user **ACKs** a **table agent**'s tables, and a **column prune
agent** runs before generation.

## From the source

*QueryGPT – Natural Language to SQL Using Generative AI* describes the hackday version and why it
stopped scaling: similarity search over schemas and samples returned irrelevant results, there was
no step between the question and the schemas, and some Tier-1 tables span over 200 columns and
cost 40–60K tokens each, so three of them broke the 32K-token model of the time. The current
design is the one this course builds around: twelve system workspaces (Mobility, Core Services,
Platform Engineering, IT, Ads and others) plus custom ones; an LLM call to infer intent and narrow
the search; a table agent whose list the user confirms with "Looks Good" or edits; a column prune
agent that returns skinnier schemas and cut both the cost and the latency of every generation; and
an output that is still SQL plus an explanation. The evaluation section is where most of this
course's guards come from: per question they record intent accuracy, a table-overlap score between
0 and 1, whether the query ran, whether it returned any rows — because hallucinated filters like
\`status = "Finished"\` run cleanly and return nothing — and an LLM-judged similarity to the golden
SQL, and their own dashboard shows a query failing repeatedly for a missing partition filter. The
learnings name the rest: LLMs classify well when given one small job, hallucinated tables and
columns remain unsolved, and five-word questions with typos need a prompt enhancer.

## What you build here

One service, **querygen**, on the \`querygen\` support package (\`config\`, the \`queries\` store, \`catalog\`
DDL) and \`text_to_sql.proto\` (\`Agents\`, \`Warehouse\`; stand-ins in the checks):

1. \`POST /v1/queries\`: capped question, allow-listed workspace, \`Idempotency-Key\`, **202**
   \`pending_ack\` with \`tables_proposed\`.
2. **Redis**: \`decision:{workspace}:{sha256}\` for a day; \`budget:{user}\` reserved by one Lua script.
3. **gRPC** \`generate_sql\`: deadlines, one retry on \`UNAVAILABLE\`, pruning over 24 000 tokens,
   \`GenerationError\`.
4. \`POST /v1/queries/{id}/run\`: one \`SELECT\`, ACKed tables, a \`datestr\` filter, \`LIMIT 1000\`, 60 s;
   \`run_ok\` and \`has_output\` saved.
5. **Kafka** \`query.feedback\` keyed by user, idempotent; the \`eval\` consumer writes \`eval:{workspace}\`,
   then commits.

## The debugging habit

Debug each starter against the failure modes, fix it, and prove the fix with checks.

## Left out on purpose

The ACK endpoint, embeddings, custom workspaces, the prompt enhancer, the validation agent and the
LLM judge.`,
  diagram: {
    nodes: [
      {id: 'analyst', kind: 'client', label: 'Query editor', sub: 'ask · ACK · run · rate', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'querygen API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queries · decision · budget · eval', x: 44, y: 14},
      {id: 'agents', kind: 'grpc', label: 'Agents', sub: 'Intent · PickTables · PruneColumns · Generate', x: 44, y: 42},
      {id: 'workspaces', kind: 'db', label: 'Workspaces', sub: 'tables · samples · schemas', x: 66, y: 30},
      {id: 'warehouse', kind: 'db', label: 'Warehouse', sub: 'partitioned by datestr', x: 44, y: 70},
      {id: 'kafka', kind: 'kafka', label: 'query.feedback', sub: 'key = user', x: 44, y: 92},
      {id: 'consumer', kind: 'service', label: 'Eval consumer', sub: 'group eval', x: 66, y: 92},
    ],
    edges: [
      {from: 'analyst', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL · GET/SET EX'},
      {from: 'api', to: 'agents', kind: 'grpc', label: 'deadline 10 s / 30 s'},
      {from: 'agents', to: 'workspaces', kind: 'plain', label: 'tables · samples'},
      {from: 'api', to: 'workspaces', kind: 'plain', label: 'schema_for(table)'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'Execute · LIMIT 1000 · 60 s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce query.feedback'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY eval:{workspace}'},
    ],
  },
  steps: [queryEndpointStep, decisionCacheStep, agentChainStep, runGuardStep, feedbackEvalStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
