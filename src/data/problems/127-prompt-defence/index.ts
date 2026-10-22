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
    "Dropbox's prompt-injection research as a service: token caps, control-character stripping, repeated-token detection, a canaried template, an output guard and attack signatures — reviewed like production.",
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
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
behind that box pastes the document and the question into a prompt and returns what the model
says. Everything in that sentence is attacker-controlled except the template — and Dropbox's
security team showed that the template alone does not hold. The system around it is what decides
whether the user gets the notice period, the model's instructions, or someone else's data.

## The real system

A question-answering feature over user documents is a prompt template with two untrusted holes in
it: the document, which may have been written by anyone who could share a file, and the question,
which comes from a web form or an API. Production systems treat both as input to a parser they do
not control. They cap input in the unit the model counts in, normalise the characters the model
tokenises strangely, and look for the repetition that makes a model diverge. They put the
instructions and the data in separate, delimited sections and plant a canary so an echoed prompt is
detectable. They check the answer before returning it — is it grounded, does it contain a secret
the document never had, is it looping — and they count the incidents without storing the text.

## From the source

*Don't you (forget NLP)* describes the Q&A template the team experimented with — instructions, a
configurable "I don't know" phrase, a word limit, the context, and the question delimited by triple
backticks — and what happened when control characters were put in the user-controlled part. A
single carriage return between two questions changed nothing; 350 of them made GPT-3.5 answer only
the second. Backspaces sent as the JSON string \`\\b\` did the same from about 450. Prepending
backspaces equal to the prompt length plus 256, 512, 1 024, 2 048 and 3 500 pushed the model from
"I'm afraid I don't know that, Dave" through answering out-of-context questions to hallucinating
the first hundred digits of π; each encoded backspace was a token, so 3 500 of them used most of a
4 096-token window. The post's mitigation guidance is where this course starts: sanitise control
characters for the model you use, and reason about input in tokens. *Bye Bye Bye...* follows the
thread to its cause — token repetition, not characters — and shows single tokens (\`dog\` × 16 000)
and two-token phrases (\`jq_THREADS\` × 2 048, \`/goto maiden\` × 12 000) making GPT-3.5 and GPT-4
diverge into memorised text: jq's documentation, verses of Genesis. It reports the provider's
filter moving from single- to multi-token repeats after disclosure, a "repeat this word forever"
request that produced output for ten minutes until a proxy timed out, and names \`max_tokens\` and
input sanitisation as the mitigations. This course takes from it the repeat-ratio detector over 1–3
token sequences, applied to the question on the way in and to the answer on the way out, the
output cap, and the idea that an attack is a signature worth counting over time.

## What you build here

One service, **promptguard**, with five pieces:

1. \`POST /v1/ask\`: authenticated user, \`Idempotency-Key\`, control characters and their escape
   strings stripped before anything is measured, a cap of **512 tokens** counted with the model's
   tokenizer, and a **422** when the most repeated 1–3 token sequence covers more than half of a
   question of 64 tokens or more. Logs carry ids and counts, never the question.
2. A **Redis** layer: 30 questions per user per 60-second window reserved by one atomic Lua
   script with the expiry set on first write; a block-list \`flagged:{sha256}\` of questions that
   made the model leak, kept for 24 hours; sessions \`session:{user}:{document}\` that expire after
   30 minutes of silence.
3. A **gRPC** model call: instructions, \`<<<DOCUMENT … DOCUMENT>>>\` and the question in triple
   backticks as separate, escaped sections; a per-request canary the model must never repeat; a
   5-second deadline, \`max_tokens = 256\`, at most two attempts; a JSON answer schema; and
   \`Rejected\` when the canary or an instruction line comes back.
4. An **output guard**: every cited span a substring of the document, a secret/PII table whose
   matches the document does not contain, the repeat ratio on the answer's tokens as a divergence
   signal; a fixed refusal instead of the model's text, and a signature in the log instead of the
   answer.
5. A **Kafka** path: one \`prompt.security\` event per decision keyed by user, idempotent with
   \`acks=all\`, never carrying text; a consumer that counts signatures per hour in Redis and
   commits only after the write.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it answers the demo
question, and it sounds confident. Your job in every step is the job you will have on a real AI
feature: read the draft against the failure modes the source documents, name the subtle one, fix
it, and prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

The tokenizer itself, the document store and its permissions, a second model as a judge, the
provider's own repeated-token filter, streaming answers, multi-turn memory beyond a session's
hashes, and the dashboard over the hourly signatures. The five pieces above are the ones that
decide whether a question about a file gets an answer from the file.`,
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
