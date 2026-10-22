import {UBER} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {queryEndpointStep} from './steps/1-query-endpoint';
import {decisionCacheStep} from './steps/2-decision-cache';
import {agentChainStep} from './steps/3-agent-chain';
import {runGuardStep} from './steps/4-run-guard';
import {feedbackEvalStep} from './steps/5-feedback-eval';

/**
 * Uber's QueryGPT on the AI-era track: not "ask a model for SQL", but the service around the
 * agents that makes the SQL safe to run. A validated, idempotent query endpoint that resolves a
 * workspace and proposes tables for the user's ACK → a Redis layer that caches decisions by
 * workspace and normalised question, reserves a per-user budget atomically and expires pending
 * ACKs → the agent chain under per-call deadlines with column pruning before generation and
 * defensively parsed output → a run endpoint that never executes generated SQL as-is → a
 * feedback topic carrying the evaluation signals, aggregated per workspace before the commit.
 */
export const textToSqlProblem: Problem = {
  id: 'text-to-sql',
  title: 'Text-to-SQL',
  tagline:
    "Uber's QueryGPT: intent and table agents behind a guarded endpoint, pruned schemas under deadlines, generated SQL that never runs as-is — reviewed like production.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
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

An operations manager types "number of trips completed by Teslas in Seattle yesterday" into a box
and expects a query that runs against the right tables in a warehouse with hundreds of thousands of
datasets. A model can write that query in seconds. Whether it names a table that exists, filters on
the partition column, and runs without scanning a year of data is decided by the service around
the model — and that service is what you review here.

## The real system

Uber's **QueryGPT** turns natural-language questions into SQL for engineers, operations managers
and data scientists, against a data platform that handles about 1.2 million interactive queries a
month. The first version was a plain RAG: embed the question, nearest-neighbour search over table
schemas and SQL samples, put the top three tables and seven samples into a prompt with custom
instructions, get back SQL and an explanation. It worked on seven tables and degraded as more were
onboarded, because a question like "trips completed yesterday in Seattle" does not embed anywhere
near a \`CREATE TABLE\` statement. The production design decomposes the problem into small
classifier calls: an **intent agent** maps the question to one or more **workspaces** — curated sets
of tables and samples per business domain — a **table agent** picks tables that the user **ACKs or
edits**, a **column prune agent** drops the columns a wide table does not need so the schemas fit
the model's context, and only then does generation run. An evaluation set of real questions with
verified intents, tables and golden SQL tracks every change.

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
columns remain unsolved, and five-word questions with typos need a prompt enhancer. Steps 1 and 2
take the workspaces, the intent agent and the ACK; step 3 the deadlines, the pruning and the
parsed output; step 4 the partition filter, the ACKed tables and the has-output signal; step 5 the
evaluation signals themselves.

## What you build here

One service, **querygen**, with five pieces:

1. \`POST /v1/queries\`: authenticated user, a question capped at 2000 characters, a workspace from
   the system allow-list or from the intent agent and checked against the same list, an
   \`Idempotency-Key\`, and a **202** that proposes tables for the user's ACK without generating
   SQL yet.
2. A **Redis** layer: the table decision cached under \`decision:{workspace}:{sha256(normalised
   question)}\` for 24 hours, a budget of 50 queries per user per hour reserved by one atomic Lua
   \`EVAL\` before the first agent call, and the pending ACK under \`pending:{query_id}\` for ten
   minutes.
3. A **gRPC** agent chain: \`Intent\`, \`PickTables\`, \`PruneColumns\` at 10 s and \`Generate\` at
   30 s, two attempts on \`UNAVAILABLE\` only, pruning when the schemas estimate above 24 000
   tokens, and the model's \`{sql, explanation}\` parsed defensively.
4. \`POST /v1/queries/{id}/run\`: one \`SELECT\`, tables ⊆ the ACKed list, a \`datestr\` partition
   filter, \`LIMIT 1000\` injected, a 60-second statement timeout, **422** when any guard fails, and
   \`has_output\` in the response.
5. A **Kafka** path: one \`query.feedback\` event per query keyed by user with the evaluation
   signals — workspace, tables proposed and ACKed, run success, has-output, rating — from an
   idempotent producer, and an \`eval\` consumer that computes table overlap and success rates
   into \`eval:{workspace}\` before it commits.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

The embeddings and vector search behind the table agent, custom workspace authoring, the prompt
enhancer, the chat mode for iterating on a query, the validation agent that repairs hallucinated
columns, the LLM judge against golden SQL, and warehouse authorisation per table. The five pieces
above are the ones that decide whether generated SQL is safe to run and whether anyone can tell
which agent got it wrong.`,
  diagram: {
    nodes: [
      {id: 'analyst', kind: 'client', label: 'Query editor', sub: 'ask · ACK · run · rate', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'querygen API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'decision · budget · pending', x: 44, y: 14},
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
      {from: 'api', to: 'workspaces', kind: 'plain', label: 'schemas_for(tables)'},
      {from: 'api', to: 'warehouse', kind: 'plain', label: 'guarded SELECT · LIMIT · timeout'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce query.feedback'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY eval:{workspace}'},
    ],
  },
  steps: [queryEndpointStep, decisionCacheStep, agentChainStep, runGuardStep, feedbackEvalStep],
};
