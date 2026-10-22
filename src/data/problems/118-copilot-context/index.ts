import {GITHUB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {completionEndpointStep} from './steps/1-completion-endpoint';
import {neighboringTabsStep} from './steps/2-neighboring-tabs';
import {fimCallStep} from './steps/3-fim-call';
import {completionTelemetryStep} from './steps/4-completion-telemetry';

/**
 * GitHub Copilot's completion context, rebuilt as the service behind an editor's ghost text and
 * reviewed like production: a request that fits the ~6,000-character window → neighboring-tab
 * snippets cached per session and ranked with a very low bar → a fill-in-the-middle call under a
 * keystroke deadline that shows at most the n it generated → shown/accepted telemetry that carries
 * ids and sizes and never code.
 */
export const copilotContextProblem: Problem = {
  id: 'copilot-context',
  title: 'Completion Context',
  tagline:
    "GitHub Copilot's prompt path: a 6,000-character window, neighboring-tab snippets, fill-in-the-middle under a keystroke deadline, and acceptance telemetry without the code — reviewed like production.",
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
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
after the cursor, and they either keep typing over it or press Tab. Behind that keystroke is a
service that has to decide, in the time it takes to type the next character, which few thousand
characters of the developer's code the model gets to see, what to ask it, and what to show back.
The model is the smallest part of that decision. The parts that decide whether the feature is safe,
cheap and good are the prompt budget, the cache of the other open files, the shape of the model
call, and the telemetry that proves any of it works.

## The real system

GitHub Copilot's completions come from a **prompt library**: algorithms select relevant snippets
from the current file and other sources, prioritise and filter them, and assemble a prompt of
about **6,000 characters** — the limit of the transformer that is fast enough to answer on every
keystroke. **Neighboring tabs** adds snippets from the other files the developer has open, matched
against the code around the cursor. **Fill-in-the-middle** sends the code before the cursor and the
code after it as a prefix and a suffix, so the model generates what belongs between them. The
model returns *n* completions and the product shows at most *n*, after a contextual filter. Every
change is judged by an A/B experiment on the acceptance rate, which is why the telemetry path is
part of the product and not an afterthought.

## From the source

*How GitHub Copilot is getting better at understanding your code* describes the pipeline this
course rebuilds. It gives the window — transformers fast enough for completion read about 6,000
characters — and the prompt library's four verbs: select, prioritise, filter, assemble. It
describes neighboring tabs as finding matching pieces of code between the open files and the code
around the cursor, and reports the A/B result that a **very low bar** for including a match gave
the best suggestions and a 5 % relative lift in acceptance; one engineer is quoted saying that the
best match found, even a weak one, beat including nothing. It describes fill-in-the-middle as
telling the model which part of the prompt is the prefix and which the suffix, worth a 10 % relative
lift, and notes that caching keeps both techniques free of added latency. Its diagram of the life
of a completion — open tabs, editor data and (later) a vector database into the prompt library,
through a contextual filter model and the model, *n* completions generated, ≤ *n* shown — is the
diagram of this course. *Inside GitHub* adds the history: the file path and language at the top of
the prompt, and the component that scans the other open tabs for text similar to the cursor's
surroundings. *How to build an enterprise LLM application* contributes the operating numbers:
acceptance rate and retention rate as the metrics, A/B experimentation as the method, cached
responses for consistency and cost, and the lesson that generating ten suggestions up front when
most developers take the first is paid-for compute nobody reads.

## What you build here

One service, **completiond**, with four pieces:

1. \`POST /v1/completions\`: a required \`X-Session-Id\` (**401** without it), a request over
   **1 MiB** refused with **413**, the prefix trimmed to its last **3,500** characters and the
   suffix to its first **1,000** so that, with the snippets, the prompt fits **6,000**, a fresh
   \`request_id\` and the editor's \`token\` echoed on every reply, and a log line that carries ids
   and sizes, never code.
2. The **neighboring-tabs cache** in Redis: each open tab under \`tabs:{session}:{path}\` with a
   **600 s** TTL, snippets scored by Jaccard set similarity of identifiers against the last **60**
   lines before the cursor, included at the very low bar of **0.05** with the best match kept even
   below it, the top **4** chosen, all of a session's tabs read with one \`MGET\`.
3. The **gRPC** model call: \`Complete\` with \`prefix\` and \`suffix\` as separate fields, a
   **300 ms** deadline, at most **2** attempts and only on \`UNAVAILABLE\`, **3** candidates
   requested and at most 3 shown after empty, truncated and duplicate ones are dropped.
4. The **Kafka** telemetry path: \`completion.shown\` and \`completion.accepted\` keyed by session
   with \`request_id\`, \`language\`, \`candidate_len\` and \`latency_ms\` and never the code, an
   idempotent producer with \`acks=all\`, and a consumer that updates
   \`HINCRBY acceptance:{language}\` before it commits.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

The model itself and its tokenizer, the contextual filter model, the public-code match filter,
embeddings and the vector database for repository-wide retrieval, editor-side debouncing and ghost
text rendering, multi-line versus single-line guardrail metrics, and the A/B experimentation
platform. The four pieces above are the ones that decide what the model sees, how long a
keystroke waits, and whether the acceptance rate can be believed.`,
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
