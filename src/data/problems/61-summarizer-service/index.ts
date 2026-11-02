import type {Problem} from '@/lib/types';

import {summarizerEndpointStep} from './steps/1-endpoint';
import {summarizerStateStep} from './steps/2-state';
import {summarizerClientStep} from './steps/3-dependency';
import {summarizerEventsStep} from './steps/4-events';
import {summarizerReadStep} from './steps/5-read';

/**
 * Summarization service: the course is not "call a model and print a paragraph", it is the
 * debugging you owe a summarizer before anyone reads its output as fact. A source reference with a
 * hard byte cap and a length band that only the platform may choose → a Redis progress record whose
 * rolling summary and chunk counter move atomically under a content hash → a gRPC call with a
 * deadline whose failure becomes a labelled extractive fallback → one `summary.done` event keyed by
 * source hash carrying numbers and no text → a read that returns sentence-level citations and marks
 * the ones an edit invalidated stale.
 */
export const summarizerServiceProblem: Problem = {
  id: 'summarizer-service',
  title: 'Summarization Service',
  tagline:
    'A summarizer whose progress record is bound to the source content hash and whose citations go stale on edit.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Summarization Service

A summarization service turns a long source into the short version somebody reads instead of the
source. The visible part is a paragraph; what decides whether the platform is trustworthy is the cap
on one request, the rule that fixes a summary's length, the state that lets a long source be
summarized incrementally, what happens when the model call fails, what the event stream carries,
and whether the citations still point at the text they came from.

## The real system

Google's Document AI enforces the request cap before any model work: online \`process\` requests are
capped at 40 MB and 15 pages, and anything larger goes through the asynchronous \`batchProcess\`
path, which takes files up to 1 GB and, depending on the processor, up to 500 pages. The cap is a
request-shape rule, not a model limit, and the documented answer to a source over it is a different
write path rather than a refusal. Summarizers that sit in front of a model apply the same shape
downstream: the length band is a policy input from a table, chunked progress is bound to a content
hash, a failed model call yields a labelled extract, completion events carry numbers rather than
text, and a read returns citations that resolve into one version of the source.

## What you build here

One service, **summarizerd**, with five pieces:

1. \`POST /v1/summaries\`: a **1 MiB** cap with a \`413\` that points at the chunked write path, a
   band resolved from the platform table, and an \`Idempotency-Key\`.
2. A **Redis** progress record keyed by \`(tenant, source content hash)\` with a TTL, committed by
   one Lua script.
3. A **gRPC** client with a **5-second** deadline, terminal refusals, and a trimmed extract marked
   \`extractive\` on failure.
4. A **Kafka** \`summary.done\` path keyed by source hash, carrying numbers only, with an idempotent
   producer, an outbox, and the record persisted before the offset commits.
5. \`GET /v1/summaries/{id}\`: sentence-level citations into the named source hash, stale marking
   for chunks an edit changed, and a \`404\` for another tenant's id.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes the task names,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Source ingestion, chunking strategy and overlap, prompt and model selection per band, evaluation
sets, streaming to the browser, multi-language summaries, retention policy and cost accounting.`,
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
