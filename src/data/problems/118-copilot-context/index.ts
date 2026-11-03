import {GITHUB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {completionEndpointStep} from './steps/1-completion-endpoint';
import {neighboringTabsStep} from './steps/2-neighboring-tabs';
import {fimCallStep} from './steps/3-fim-call';
import {completionTelemetryStep} from './steps/4-completion-telemetry';

/**
 * GitHub Copilot's completion context, rebuilt as the service behind an editor's ghost text and
 * debugged like production: a request that fits the ~6,000-character window → neighboring-tab
 * snippets cached per session and ranked with a very low bar → a fill-in-the-middle call under a
 * keystroke deadline that shows at most the n it generated → shown/accepted telemetry that carries
 * ids and sizes and never code.
 */
export const copilotContextProblem: Problem = {
  id: 'copilot-context',
  title: 'Completion Context',
  tagline:
    "GitHub Copilot's prompt path: a 6,000-character window and fill-in-the-middle under a 300 ms keystroke deadline.",
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 45,
  company: GITHUB,
  sources: [
    {
      title: 'How GitHub Copilot is getting better at understanding your code',
      url: 'https://github.blog/ai-and-ml/github-copilot/how-github-copilot-is-getting-better-at-understanding-your-code/',
      by: 'Johan Rosenkilde',
      date: '2023-05-17',
      takes:
        'The mechanisms and numbers: a prompt library that selects, prioritises, filters and assembles snippets into a window of about 6,000 characters; neighboring tabs, where snippets from the other open files are matched against the code around the cursor with a deliberately very low inclusion bar (+5 % acceptance); fill-in-the-middle, which tells the model which part is prefix and which is suffix (+10 %); caching so that neither adds latency; and the life of a completion — n generated, at most n shown.',
    },
    {
      title: 'Inside GitHub: Working with the LLMs behind GitHub Copilot',
      url: 'https://github.blog/ai-and-ml/github-copilot/inside-github-working-with-the-llms-behind-github-copilot/',
      by: 'Sara Verdi',
      date: '2023-05-17',
      takes:
        'The origin of the two prompt tricks this course builds — the file path and language at the top of the prompt, and the component that scans the other open tabs for text similar to what is around the cursor, credited with a large lift in acceptance and characters retained.',
    },
    {
      title: 'How to build an enterprise LLM application: Lessons from GitHub Copilot',
      url: 'https://github.blog/ai-and-ml/github-copilot/how-to-build-an-enterprise-llm-application-lessons-from-github-copilot/',
      by: 'Shuyin Zhao',
      date: '2023-09-06',
      takes:
        'The operating numbers: code acceptance rate and later retention rate as the product metrics, A/B experiments as the way every change is judged, caching the same prompt to keep suggestions consistent and cheap, and the cost of eagerly generating ten suggestions when most developers take the first.',
    },
  ],
  statement: `# Completion Context

A developer types a character in \`db/conn.py\`; within a few hundred milliseconds grey text appears
after the cursor. Behind that keystroke a service decides which few thousand characters of code the
model sees, what to ask it, and what to show back.

## The real system

GitHub Copilot's completions come from a **prompt library** that selects, prioritises, filters and
assembles snippets into a prompt of about **6,000 characters**. **Neighboring tabs** adds snippets
from the other open files, matched against the code around the cursor. **Fill-in-the-middle** sends
the code before and after the cursor as a prefix and a suffix.

## From the source

*How GitHub Copilot is getting better at understanding your code* gives the window (about 6,000
characters) and the prompt library's four verbs. It reports that a **very low bar** for including a
neighboring-tab match gave a 5 % relative lift in acceptance, with the best match beating nothing
even when weak; fill-in-the-middle was worth 10 %, and caching keeps both free of added latency. Its
diagram of the life of a completion (*n* generated, ≤ *n* shown) is this course's diagram. *Inside
GitHub* adds the file path and language at the top of the prompt. *How to build an enterprise LLM
application* contributes acceptance and retention rate as the metrics and the lesson that generating
ten suggestions when most developers take the first is wasted compute.

## What you build here

One service, **completiond**, with four pieces:

1. \`POST /v1/completions\`: a required \`X-Session-Id\` (**401**), **413** over **1 MiB**, the
   prefix trimmed to its last **3,500** characters and the suffix to its first **1,000**, a fresh
   \`request_id\` and the editor's \`token\` echoed, and a log line without code.
2. The **neighboring-tabs cache** in Redis: \`tabs:{session}:{path}\` with a **600 s** TTL, Jaccard
   scoring against the last **60** lines before the cursor, a **0.05** bar with the best match kept
   below it, the top **4** chosen, one \`MGET\` per session.
3. The **gRPC** model call: \`Complete\` with separate \`prefix\` and \`suffix\`, a **300 ms**
   deadline, at most **2** attempts only on \`UNAVAILABLE\`, **3** candidates with empty, truncated
   and duplicate ones dropped.
4. The **Kafka** telemetry path: \`completion.shown\` and \`completion.accepted\` keyed by session
   with \`request_id\`, \`language\`, \`candidate_len\` and \`latency_ms\`, an idempotent producer with
   \`acks=all\`, and \`HINCRBY acceptance:{language}\` before the commit.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

The model and its tokenizer, the contextual filter model, embeddings and repository-wide retrieval,
editor-side debouncing, and the A/B platform.`,
  diagram: {
    nodes: [
      {id: 'editor', kind: 'client', label: 'Editor', sub: 'ghost text · open tabs', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'completiond', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'tabs:{session}:{path} · acceptance', x: 50, y: 20},
      {id: 'model', kind: 'grpc', label: 'Model service', sub: 'Complete · prefix + suffix', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'completion.shown · accepted', sub: 'key = session', x: 50, y: 80},
      {id: 'consumer', kind: 'service', label: 'Acceptance consumer', sub: 'group acceptance', x: 72, y: 80},
    ],
    edges: [
      {from: 'editor', to: 'api', kind: 'http', label: 'POST /v1/completions · /v1/telemetry'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET EX 600 · MGET'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Complete · 300 ms'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce · key = session'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY acceptance:{language}'},
    ],
  },
  steps: [completionEndpointStep, neighboringTabsStep, fimCallStep, completionTelemetryStep],
};
