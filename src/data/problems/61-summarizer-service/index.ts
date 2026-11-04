import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {summarizerEndpointStep} from './steps/1-endpoint';
import {summarizerStateStep} from './steps/2-state';
import {summarizerClientStep} from './steps/3-dependency';
import {summarizerEventsStep} from './steps/4-events';
import {summarizerReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Summarization service: the course is not "call a model and print a paragraph", it is the
 * debugging you owe a summarizer before anyone reads its output as fact. A 1 MiB request cap and a
 * band only the platform table sets → Redis progress for a chunked source under its content hash,
 * moved by one script → a model call with a deadline, a retry budget and a labelled extractive lead
 * → a `summary.done` event keyed by source hash, carrying numbers, after the record is saved → a
 * tenant-scoped read whose citations go stale when the source changes. One provided package,
 * `summarizer` (`text` and `store`), runs under every step.
 */
export const summarizerServiceProblem: Problem = {
  id: 'summarizer-service',
  title: 'Summarization Service',
  tagline:
    'A summarizer whose progress is keyed by content hash and whose citations go stale when the source is edited.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Summarization Service

A summarization service turns a long source into the short version people read instead of it. The
paragraph is the visible part; whether anyone can trust it depends on what surrounds it: a cap on
what one request may carry, a length the platform decides, progress that knows which version of the
source it belongs to, a model call that cannot hang, events that carry numbers rather than text, and
citations that say when the text they point at has changed.

## The real system

Google's Document AI caps an online \`process\` request at 40 MB and 15 pages and sends anything
larger to \`batchProcess\`, which takes files up to 1 GB. The cap belongs to the request path, and the
answer to a source over it is another path rather than a refusal. This course builds the same split
for text (a 1 MiB synchronous path whose 413 points at the chunked one) and the rest of the shape
around a model: per-version progress, a bounded call with an extractive fallback, a completion event
and a read with citations.

## What you build here

One service, **summarizerd**, on one summary store (\`summarizer.store\`, provided: sources, summary
records, request keys, the outbox) and one set of text rules (\`summarizer.text\`, provided: chunks
are separated by a blank line, \`content_hash\` is SHA-256, \`lead\` is the extractive lead, \`cite\`
points each summary sentence at its chunk):

1. \`POST /v1/summaries\` \`{source_ref, content, band}\` with \`X-Tenant-Id\` and \`Idempotency-Key\`:
   a 1 MiB cap whose 413 names \`/v1/sources/{source_ref}/chunks\`, a band from \`BAND_TARGETS\`, and
   \`store.replay\` / \`store.remember\` per request key.
2. **Redis** progress for a chunked source under \`summary:progress:{tenant}:{source_hash}\`, moved by
   one Lua script that applies only the next chunk and refreshes a one-hour TTL.
3. The **gRPC** \`SummaryModel.Summarize\` call: a 5-second deadline, at most three attempts on
   \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, and the extractive lead labelled \`extractive\` when the
   model gives nothing.
4. **Kafka** \`summary.done\`, keyed by \`source_hash\`, carrying ids and numbers (\`compression_ratio\`,
   \`model_version\`, \`chunks_done\`), produced after \`save_summary\` by an idempotent producer, with
   an outbox row when the broker does not acknowledge.
5. \`GET /v1/summaries/{id}\`: scoped to the tenant, with \`stale\`, \`stale_chunks\` and a quote per
   citation while its chunk is unchanged.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Source ingestion and the chunk upload route itself, chunking strategy and overlap, prompt and model
selection per band, evaluation sets, streaming to the browser, multi-language summaries, retention
policy and cost accounting.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'summarizerd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'rules', kind: 'db', label: 'Band rules', sub: 'short 100 · medium 250 · long 600', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'summary:progress:{tenant}:{hash}', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'summary.done', sub: 'key = source hash', x: 50, y: 88},
      {id: 'store', kind: 'db', label: 'Summary store', sub: 'sources · records · outbox', x: 74, y: 24},
      {id: 'model', kind: 'grpc', label: 'Summary model', sub: 'Summarize · 5 s · 3 attempts', x: 74, y: 50},
      {id: 'extract', kind: 'external', label: 'Extractive lead', sub: 'kind = extractive', x: 74, y: 76},
      {id: 'consumer', kind: 'service', label: 'Summary consumers', sub: 'compression · model version', x: 92, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'rules', kind: 'plain', label: 'BAND_TARGETS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA commit chunk'},
      {from: 'api', to: 'store', kind: 'plain', label: 'create · save · load · replay'},
      {from: 'api', to: 'model', kind: 'grpc', label: 'Summarize'},
      {from: 'api', to: 'extract', kind: 'plain', label: 'no model summary'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after save'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'store', to: 'kafka', kind: 'plain', label: 'outbox relay'},
    ],
  },
  steps: [summarizerEndpointStep, summarizerStateStep, summarizerClientStep, summarizerEventsStep, summarizerReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
