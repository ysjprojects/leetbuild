import {DROPBOX} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {askEndpointStep} from './steps/1-ask-endpoint';
import {userLimitsStep} from './steps/2-user-limits';
import {modelCallStep} from './steps/3-model-call';
import {answerGuardStep} from './steps/4-answer-guard';
import {securityEventsStep} from './steps/5-security-events';

/**
 * Dropbox's prompt-injection research turned into the service that sits around an
 * ask-a-question-about-this-file feature: a question endpoint that counts tokens, strips control
 * characters and measures repeated tokens → per-user windows, a block-list and sessions in Redis,
 * each with a TTL → a model call behind a sectioned template with a canary, a deadline and a
 * schema → an output guard for grounding, secrets and divergence → user-keyed security events
 * aggregated into hourly attack signatures.
 */
export const promptDefenceProblem: Problem = {
  id: 'prompt-defence',
  title: 'Prompt Injection Defence',
  tagline:
    "Dropbox's prompt-injection research as a service: a token cap and control-character stripping on the way in, a canaried template and a signature-logging output guard on the way out.",
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 75,
  company: DROPBOX,
  sources: [
    {
      title: "Don't you (forget NLP): Prompt injection with control characters in ChatGPT",
      url: 'https://dropbox.tech/machine-learning/prompt-injection-with-control-characters-openai-chatgpt-llm',
      by: 'Mark Breitenbach, Adrian Wood, Win Suen, Po-Ning Tseng',
      date: '2023-07-19',
      takes:
        'The question-and-answer prompt template with the question in triple backticks; the finding that a few hundred carriage returns or JSON-encoded backspaces in user-controlled text — each one a token — make GPT-3.5 forget the instructions and context before them and eventually hallucinate; the token-count framing (4 096-token window, 3 500 backspaces) and the mitigations the post names: sanitise control characters for the chosen model, and treat the problem as one of tokens rather than characters.',
    },
    {
      title: 'Bye Bye Bye...: Evolution of repeated token attacks on ChatGPT models',
      url: 'https://dropbox.tech/machine-learning/bye-bye-bye-evolution-of-repeated-token-attacks-on-chatgpt-models',
      by: 'Mark Breitenbach, Adrian Wood',
      date: '2024-03-19',
      takes:
        'Repeated single tokens (dog × 16 000, accomplishment × 3 500) and multi-token phrases (jq_THREADS × 2 048, /goto maiden × 12 000) that make GPT-3.5 and GPT-4 diverge into memorised training data; the loop of a short phrase repeated to the token limit as the tell-tale output; the ten-minute "repeat this forever" request and max_tokens as the cost mitigation; and the evolution of the provider-side filter from single to multi-token repeats, which this course answers with its own repeat-ratio detector on input and output.',
    },
  ],
  statement: `# Prompt Injection Defence

A user opens a contract in their file store and asks, "What is the notice period?" The feature
pastes the document and the question into a prompt, and Dropbox's security team showed that the
template alone does not hold.

## The real system

A question-answering feature over user documents is a prompt template with two untrusted holes: the
document and the question. Rebuff, Protect AI's open-source injection detector, adds a canary word
to the prompt template and checks whether the completion leaked it.

## From the source

*Don't you (forget NLP)* describes a Q&A template with the question in triple backticks and what
control characters in the user-controlled part did to it: one carriage return changed nothing,
350 made GPT-3.5 answer only the second of two questions, and backspaces sent as the JSON string
\`\\b\` did the same from about 450. Each encoded backspace was a token, so 3 500 of them used most
of a 4 096-token window. The guidance: sanitise control characters for your model, and reason in
tokens. *Bye Bye Bye...* follows the thread to token repetition: \`dog\` × 16 000 or
\`jq_THREADS\` × 2 048 made GPT-3.5 and GPT-4 diverge into memorised text, a "repeat this word
forever" request ran for ten minutes until a proxy timed out, and the provider's filter moved from
single- to multi-token repeats after disclosure.

## What you build here

One service, **promptguard**, with five pieces:

1. \`POST /v1/ask\`: authenticated user, \`Idempotency-Key\`, control characters stripped before
   anything is measured, a **512-token** cap, and **422** when one 1–3 token sequence covers more
   than half of a 64-token question.
2. A **Redis** layer: 30 questions per user per minute reserved by one Lua script, a 24-hour
   block-list \`flagged:{sha256}\`, sessions that expire after 30 minutes of silence.
3. A **gRPC** model call: escaped, delimited sections, a per-request canary, a 5-second deadline,
   \`max_tokens = 256\`, a JSON answer schema and \`Rejected\` on a leak.
4. An **output guard**: grounded spans, a secret/PII table, the repeat ratio on the answer, a fixed
   refusal and a signature in the log.
5. A **Kafka** path: one \`prompt.security\` event per decision keyed by user, idempotent with
   \`acks=all\`, carrying no text; a consumer that counts signatures per hour and commits after
   the write.

## The debugging habit

Every starter compiles and answers the demo question. Debug it against the failure modes the source
documents, fix it, and prove the fix with checks.

## Left out on purpose

The tokenizer, the document store, a second model as a judge, and streaming answers.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'File viewer', sub: 'POST /v1/ask', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'promptguard', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'docs', kind: 'db', label: 'documents', sub: 'text by id', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'limits · flagged · sessions', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'prompt.security', sub: 'key = user', x: 44, y: 86},
      {id: 'model', kind: 'grpc', label: 'Model', sub: 'Complete · 5 s · 256 tokens', x: 66, y: 30},
      {id: 'consumer', kind: 'service', label: 'Signature consumer', sub: 'group signatures', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'docs', kind: 'plain', label: 'get(document_id)'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL · SETEX · EXPIRE'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Complete'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce prompt.security'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY signatures:{hour}'},
    ],
  },
  steps: [askEndpointStep, userLimitsStep, modelCallStep, answerGuardStep, securityEventsStep],
};
