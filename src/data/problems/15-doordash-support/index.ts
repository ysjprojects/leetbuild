import {DOORDASH} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {chatEndpointStep} from './steps/1-chat-endpoint';
import {kbRetrievalStep} from './steps/2-kb-retrieval';
import {modelCallStep} from './steps/3-model-call';
import {guardrailsStep} from './steps/4-guardrails';
import {tokenStreamStep} from './steps/5-token-stream';
import {qualityJudgeStep} from './steps/6-quality-judge';
import {supportModules, supportModulesGo, supportModulesTs} from './support';

/**
 * DoorDash's LLM-based Dasher support, rebuilt as the system around a model: a chat endpoint with
 * memory and limits → a knowledge base of chunks and embeddings searched by nearest neighbour, with
 * an answer cache → the model call with a deadline, a retry and a smaller fallback → a two-tier
 * guardrail that grounds the answer, judges it, or hands the Dasher to a person → tokens streamed to
 * the app as they come → every turn judged offline from a Kafka topic. The model and the judge are
 * deterministic stand-ins served by the harness: the course grades what the system guarantees.
 */
export const doordashSupportProblem: Problem = {
  id: 'doordash-support',
  title: 'Support Assistant',
  tagline:
    "DoorDash's Dasher support automation: retrieval from a knowledge base, a model called on a deadline with a fallback, a two-tier guardrail that escalates to a human, tokens streamed to the app, every turn judged offline.",
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 75,
  company: DOORDASH,
  sources: [
    {
      title: 'Path to high-quality LLM-based Dasher support automation',
      url: 'https://careersatdoordash.com/blog/large-language-modules-based-dasher-support-automation',
      by: 'Zhe Jia, Shuai Wang, Aditi Bamba, Martin Wang',
      date: '2024-09-17',
      takes:
        'The shape of the system: a multi-turn chat whose question is answered from knowledge-base articles found in a vector store and put in front of the model as context; a two-tier guardrail — semantic similarity of the answer against the retrieved segments, then an LLM evaluator for groundedness, coherence and compliance — that regenerates once and otherwise hands the conversation to a human agent; an LLM judge scoring every conversation offline, calibrated against human review.',
    },
    {
      title: 'Behind the platform: the journey to create the LinkedIn GenAI application tech stack',
      url: 'https://www.linkedin.com/blog/engineering/generative-ai/behind-the-platform-the-journey-to-create-the-linkedin-genai-application-tech-stack',
      by: 'Karthik Ramgopal, Xiaofeng Wang, Sandeep Jha',
      date: '2024-11-26',
      takes:
        'The platform half: one service in front of the models that owns quotas and streaming; gRPC between the pieces; the model behind an interface so the large one can be swapped for a smaller one; streaming tokens to the client while the answer is still being checked.',
    },
    {
      title: 'Grab AI Gateway: Connecting Grabbers to multiple GenAI providers',
      url: 'https://engineering.grab.com/grab-ai-gateway',
      by: 'Bjorn Jee, Daniel Tai, Siddharth Pandey, Wenbo Wei',
      date: '2025-02-19',
      takes:
        'Per-caller rate limits in front of expensive model calls, dynamic fallback to another model when the first one fails, and an audit trail of every request and response flowing to the data platform — here, the Redis limiter, the small-model fallback and the Kafka topic.',
    },
  ],
  statement: `# Support Assistant

A Dasher's order was cancelled at the restaurant and the app will not let them mark it; they open
support chat at 11 pm. A person could answer in a few minutes — if one were free. A model can answer
in a few seconds — and, left alone, will cheerfully invent a policy. The system around the model is
what decides which of those the Dasher gets.

## The real system

DoorDash's **Dasher support automation** answers support chats with an LLM: the conversation is
summarised into a question, similar past cases and knowledge-base articles are fetched from a vector
store, and a prompt made of them goes to the model, which answers and may call internal APIs on the
Dasher's behalf. The part that made it shippable is not the model. It is the **two-tier guardrail**
that follows every answer — a semantic-similarity check of the answer against the retrieved
knowledge-base segments, then an LLM evaluator scoring groundedness, coherence and policy
compliance — and the rule that a failed answer is regenerated once and otherwise handed to a human.
Offline, an **LLM judge** scores every conversation on five dimensions, calibrated against human
reviewers, and a regression suite gates every prompt change.

## From the source

*Path to high-quality LLM-based Dasher support automation* describes the pipeline — chat → issue
summary → top-N similar cases and KB articles from the vector store → prompt template → answer plus
API calls — and is candid about what went wrong before the guardrails existed: hallucinated policies,
wrong refund amounts, answers in the wrong language. The semantic-similarity tier is a sliding window
over the answer's sentences against the retrieved segments; the evaluator tier is a second model
call with a rubric; together they cut hallucinations by about 90% and compliance issues by about
99%. LinkedIn's *Behind the platform* post adds the platform view this course borrows: one service
in front of the models that owns quotas and streaming, gRPC between the pieces, the model behind an
interface so a smaller one can take over. Grab's *AI Gateway* contributes the per-caller rate limits,
the fallback to another model when the first fails, and the audit trail of every request flowing to
the data platform.

## What you build here

The service is **assistant**; the model and the judge are stand-ins the checks serve at
\`llm-large:50051\`, \`llm-small:50051\` and \`judge:50051\` — deterministic, so what *your* code does
around them can be graded: the model cites the chunks it was given, or invents one when asked to.

1. \`POST /chat\`: the conversation kept in Redis with a TTL, a per-Dasher rate limit, an answer with
   its sources — or the same answer from the **answer cache** without a model call.
2. The **knowledge base**: articles chunked and embedded into Postgres (\`vector(512)\`), the nearest
   chunks found with pgvector's \`<=>\`, and the cache in Redis keyed by the normalised question.
3. The **model call**: the prompt from question, history and chunks; a **deadline**; one retry on a
   transient failure; the **small model** when the large one is down or slow.
4. The **guardrail**: every cited chunk must have been retrieved and every sentence must sit close to
   one; then the judge; a failed answer is generated once more, and after that the Dasher is handed
   to a person — never the bad answer.
5. **Streaming**: \`Chat.Stream\` relays the model's tokens to the app as they arrive, checks them as
   they go, and stops the stream when the guard fails.
6. The **quality pipeline**: every answered turn is a record on \`support-conversations\`; a consumer
   judges each one, writes the scores to Postgres, and commits only after the write.

## Left out on purpose

The model itself, function calling into DoorDash's APIs, the issue summariser, the Promptfoo
regression suite, the human calibration of the judge, PII redaction, and multi-provider routing.
The six pieces above are the ones that turn a model that sometimes invents a policy into a support
channel a company can put its name on.`,
  diagram: {
    nodes: [
      {id: 'dasher', kind: 'client', label: 'Dasher app', sub: 'POST /chat · Chat.Stream', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'assistant API', sub: 'HTTPS :8443', x: 24, y: 28},
      {id: 'chat', kind: 'grpc', label: 'Chat', sub: 'gRPC :9000 · stream tokens', x: 24, y: 72},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'conv:{session} · rl:{dasher} · answer:{hash}', x: 46, y: 12},
      {id: 'pg', kind: 'db', label: 'Postgres · pgvector', sub: 'kb_chunks · quality_scores', x: 46, y: 40},
      {id: 'llm', kind: 'external', label: 'model server', sub: 'llm-large · llm-small', x: 46, y: 66},
      {id: 'judge', kind: 'external', label: 'LLM judge', sub: 'judge:50051', x: 46, y: 90},
      {id: 'kafka', kind: 'kafka', label: 'support-conversations', sub: 'key = session', x: 70, y: 28},
      {id: 'worker', kind: 'service', label: 'quality judge', sub: 'consumer group quality-judge', x: 90, y: 28},
    ],
    edges: [
      {from: 'dasher', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'dasher', to: 'chat', kind: 'grpc', label: 'Chat.Stream'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'history · limit · cache'},
      {from: 'api', to: 'pg', kind: 'plain', label: 'nearest chunks'},
      {from: 'api', to: 'llm', kind: 'grpc', label: 'Generate'},
      {from: 'api', to: 'judge', kind: 'grpc', label: 'Evaluate'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'one record per turn'},
      {from: 'chat', to: 'llm', kind: 'grpc', label: 'Stream'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'judge', kind: 'grpc', label: 'Evaluate'},
      {from: 'worker', to: 'pg', kind: 'plain', label: 'quality_scores'},
    ],
  },
  steps: [chatEndpointStep, kbRetrievalStep, modelCallStep, guardrailsStep, tokenStreamStep, qualityJudgeStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
  },
  learn,
};
