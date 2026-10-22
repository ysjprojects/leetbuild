import type {Problem} from '@/lib/types';

import {summarizerEndpointStep} from './steps/1-endpoint';
import {summarizerStateStep} from './steps/2-state';
import {summarizerClientStep} from './steps/3-dependency';
import {summarizerEventsStep} from './steps/4-events';
import {summarizerReadStep} from './steps/5-read';

/**
 * Summarization service on the AI-era track: the course is not "call a model and print a
 * paragraph", it is the review you owe a model-generated summarizer before anyone reads its output
 * as fact. A source reference with a hard byte cap and a length band that only the platform may
 * choose → a Redis progress record whose rolling summary and chunk counter move atomically under a
 * content hash → a gRPC call with a deadline whose failure becomes a labelled extractive fallback →
 * one `summary.done` event keyed by source hash carrying numbers and no text → a read that returns
 * sentence-level citations and marks the ones an edit invalidated stale.
 */
export const summarizerServiceProblem: Problem = {
  id: 'summarizer-service',
  title: 'Summarization Service',
  tagline: 'Summaries with bounded inputs, versioned length rules and no hallucinated events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Summarization Service

A summarization service is the piece of an AI platform that turns a long source into the short
version somebody will actually read instead of the source. The visible part is a paragraph; the parts
that decide whether the platform is trustworthy are the caps on what one request may carry, the rules
that fix how short a summary is allowed to be, the state that lets a long source be summarized
incrementally without claiming text it never read, what happens when the model call fails, what the
event stream carries, and whether the citations in a summary still point at the text they came from.

## The real system

Production summarizers receive a source reference and a **length band** from the platform, and they
enforce the request cap before any model work: a source over the cap is rejected with a pointer to
the chunked write path instead of being pushed through whole. The band is a policy input — \`short\`,
\`medium\` and \`long\` resolve to word budgets in a platform table — and the source text is data:
a document that says "write one sentence" cannot choose its own length any more than it can choose
the model. Long sources are summarized chunk by chunk, and per-source progress lives in **Redis**
with a TTL, written **atomically**: the rolling summary and the chunks it covers move in one step,
because a crash that leaves a summary claiming chunks it never read is a summary that invents events
that never happened. Progress is bound to the source **content hash**, so editing a source starts a
new summary line instead of appending to the old one.

The model runs over **gRPC** with a deadline, and a failure yields a trimmed extract of the source
labelled **extractive** — never a sentence that reads like a summary but says nothing, and never a
retry of a refusal that will be refused again. Completion publishes one event keyed by the **source
hash**, carrying lengths, model version and compression ratio, never the summary or the source text,
and the summary record is persisted before the offset commits. The read endpoint returns
**sentence-level pointers** into the source chunks, and an edit to the source marks the pointers into
the changed chunks **stale** rather than serving a citation that no longer resolves.

## What you build here

One service, **summarizerd**, with five pieces:

1. \`POST /v1/summaries\`: authenticated tenant, a source capped at **1 MiB** with a \`413\` that
   points at the chunked write path, a band resolved from the platform table and never from text
   inside the source, and an \`Idempotency-Key\` so a replayed request returns the stored summary.
2. A **Redis** source-progress record keyed by \`(tenant, source content hash)\` with a TTL, where
   the rolling summary and the chunk counter are committed by one Lua script, and an edited source
   starts a new summary line instead of extending the old one.
3. A **gRPC** summarizer client with a **5-second** deadline, a refusal treated as terminal, and a
   failure that returns a trimmed extract marked \`extractive\` — the output type is always labelled.
4. A **Kafka** \`summary.done\` path keyed by source hash, carrying lengths, model version and
   compression ratio and never any text, with an idempotent producer, an outbox row when the produce
   fails, and the summary record persisted **before** the offset commits.
5. \`GET /v1/summaries/{id}\`: the summary with sentence-level citations into the named source hash,
   stale marking for citations into chunks an edit changed, and a \`404\` for another tenant's id.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Source ingestion and connectors, chunking strategy and overlap, prompt and model selection per band,
fine-tuning and evaluation sets, streaming a summary to the browser, multi-language summaries,
retention and redaction policy, and cost accounting. The five pieces above are the ones that decide
whether a summary is correct, attributable and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Summarizer', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'rules', kind: 'db', label: 'Band rules', sub: 'short · medium · long', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'source progress · TTL', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'summary.done', sub: 'key = source hash', x: 50, y: 88},
      {id: 'store', kind: 'db', label: 'Summary store', sub: 'summary · citations', x: 74, y: 24},
      {id: 'model', kind: 'grpc', label: 'Summary model', sub: 'Summarize · 5 s', x: 74, y: 50},
      {id: 'extract', kind: 'external', label: 'Extractive fallback', sub: 'trimmed extract', x: 74, y: 76},
      {id: 'consumer', kind: 'service', label: 'Citation consumer', sub: 'group citations', x: 92, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'rules', kind: 'plain', label: 'band budgets'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'progress · hash'},
      {from: 'api', to: 'store', kind: 'plain', label: 'summary · citations'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Summarize(chunk)'},
      {from: 'api', to: 'extract', kind: 'plain', label: 'on failure'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce summary.done'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'citation index'},
    ],
  },
  steps: [summarizerEndpointStep, summarizerStateStep, summarizerClientStep, summarizerEventsStep, summarizerReadStep],
};
