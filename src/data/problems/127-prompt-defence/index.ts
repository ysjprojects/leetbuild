import {DROPBOX} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {askEndpointStep} from './steps/1-ask-endpoint';
import {userLimitsStep} from './steps/2-user-limits';
import {modelCallStep} from './steps/3-model-call';
import {answerGuardStep} from './steps/4-answer-guard';
import {securityEventsStep} from './steps/5-security-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Dropbox's prompt-injection research turned into the service around an ask-a-question-about-this-
 * file feature: a question endpoint that strips control characters, caps tokens and measures
 * repetition → per-user windows, a block-list and sessions in Redis, each with a TTL → a model call
 * behind a sectioned template with a canary, a deadline and a schema → an output guard for grounding,
 * secrets and divergence → user-keyed security events counted into hourly signatures. The model is a
 * deterministic stand-in the harness serves over gRPC; `promptguard` holds the shared contract.
 */
export const promptDefenceProblem: Problem = {
  id: 'prompt-defence',
  title: 'Prompt Injection Defence',
  tagline:
    "Dropbox's prompt-injection findings as a file Q&A service: tokens and control characters checked on the way in, a canaried prompt and an output guard on the way out.",
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

A question-answering feature over user documents is a prompt template with two untrusted holes, the
document and the question. Rebuff, Protect AI's open-source injection detector, generates a random
hex canary word per call, adds it to the prompt and flags any completion that contains it; this
course plants the same kind of canary.

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

One service, **promptguard**, five files sharing the \`promptguard\` support package: \`config\`
(the model at \`model:9000\`, the topic, every key, the refusal text), \`tokens\` (\`tokenize\`,
\`repeat_ratio\`), \`documents\` (\`doc:{id}\`), \`asks\` (decisions by \`(user, Idempotency-Key)\`)
and \`types\` (\`Admission\`, \`ModelAnswer\`, \`Decision\`, \`Rejected\`, \`ModelUnavailable\`).

1. \`POST /v1/ask\` \`{"document_id", "question"}\` with \`X-User-Id\` and \`Idempotency-Key\`:
   controls stripped, at most **512 tokens**, **422** when one 1–3 token sequence covers more than
   half of 64 or more; it calls \`admit\`, \`respond\` and \`remember\`.
2. **Redis** (\`limits\`): \`admit(user)\` reserves one of 30 questions in \`limits:{user}:{minute}\`
   with one Lua script; \`flag\`/\`is_flagged\` keep \`flagged:{sha256}\` for a day;
   \`remember\` keeps 20 hashes in \`session:{user}:{doc}\` for 30 minutes.
3. **gRPC** (\`model_call\`): \`answer(document, question)\` calls \`Model.Complete\` with escaped
   sections, a canary, 5 s and \`max_tokens = 256\`, and parses \`{"answer", "spans"}\`.
4. **Output guard** (\`answer_guard\`): \`respond(user, document_id, document, question)\` refuses
   ungrounded, secret-bearing or looping answers, flags rejected questions, logs a signature.
5. **Kafka** (\`security_events\`): \`publish(user, decision)\` to \`prompt.security\` keyed by user;
   \`run()\` counts refusals into \`signatures:{hour}\` and commits after the write.

## The debugging habit

Every starter is working code with flaws: it compiles, answers the demo question and looks right.
The task says where the flaws live; the checks drive the code the way the source's attacks did and
say what must change. Fix the step, then rerun its checks to prove it.

## Left out on purpose

A real BPE tokenizer (the course's \`tokenize\` is a deterministic stand-in), the document store's
write path, a second model as a judge, and streaming answers.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'File viewer', sub: 'POST /v1/ask', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'promptguard', sub: 'ask · limits · model call · guard · events', x: 26, y: 50},
      {id: 'docs', kind: 'db', label: 'documents', sub: 'doc:{id}', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'limits · flagged · session · ask · signatures', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'prompt.security', sub: 'key = user', x: 44, y: 86},
      {id: 'model', kind: 'grpc', label: 'Model', sub: 'Complete · 5 s · 256 tokens', x: 66, y: 30},
      {id: 'consumer', kind: 'service', label: 'Signature consumer', sub: 'group signatures', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'docs', kind: 'plain', label: 'get(document_id)'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA admit · SET EX · LPUSH/LTRIM/EXPIRE'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Complete'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce prompt.security'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY signatures:{hour}'},
    ],
  },
  steps: [askEndpointStep, userLimitsStep, modelCallStep, answerGuardStep, securityEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
