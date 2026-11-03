import type {Problem} from '@/lib/types';

import {citationEndpointStep} from './steps/1-endpoint';
import {citationStateStep} from './steps/2-state';
import {citationClientStep} from './steps/3-client';
import {citationEventsStep} from './steps/4-events';
import {readCitationsStep} from './steps/5-read';

/**
 * Citation store: the course is not "save a quote and a link", it is the debugging you owe a
 * citation store before anyone trusts the answer it supports. Spans that must resolve at write time
 * → a Redis span cache keyed by immutable version → a gRPC document fetch with a deadline that marks
 * unanchored citations broken → document-keyed lineage events with an outbox → a read that names its
 * evidence and reports the worst status.
 */
export const citationStoreProblem: Problem = {
  id: 'citation-store',
  title: 'Citation Store',
  tagline: 'Citations that point at exact spans in a named document version and stay valid after an edit.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Citation Store

A citation store lets an answer name its evidence: this quote, from this document, at these offsets,
in this version. Whether the product is trustworthy depends on the offset arithmetic, the version the
offsets resolve against, what happens when the document store cannot answer, and whether a
document's citation history survives an edit.

## The real system

The Claude Messages API's citations feature returns, for each cited passage of a plain-text
document, a \`char_location\` block with the \`cited_text\`, the \`document_index\` and the
\`start_char_index\` / \`end_char_index\` the quote was extracted from; the quoted text is taken
directly from the source rather than generated, which is what makes an offset pair worth storing. A
store that keeps such citations has to defend that guarantee over time, against immutable versions
rather than "the document", because a later edit re-points everything stored against a bare id.

## What you build here

One service, **citations**, with five pieces:

1. \`POST /v1/citations\`: authenticated tenant, a validated span (version, \`start < end\`, quote
   cap), the quote compared against the bytes in the **named version**, a mismatch answering **422**
   with both texts, and an \`Idempotency-Key\` so a retry cannot diverge.
2. A **Redis** span cache keyed by \`span:{document_id}:{version}:{start}:{end}\` with normalized
   offsets and a long TTL, because an immutable version cannot change.
3. A **gRPC** document fetch: a 1-second deadline per attempt, terminal \`NOT_FOUND\`, a bounded retry
   for retryable codes only, and a span that cannot be re-anchored marked \`broken\` with a reason.
4. A **Kafka** \`citation.event\` path keyed by document id, carrying version, span and status, with an
   idempotent \`acks=all\` producer, verification before publish, and an outbox on rejection.
5. \`GET /v1/citations/{id}\`: span, version, status and offset range for the owning tenant, **404**
   for a foreign citation, and an answer list reporting the worst status.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. Debug
it against the failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

Text extraction and OCR, per-format byte offsets, document storage, highlighting UIs, re-anchoring
heuristics for rewritten prose, citation quality scoring, and answer generation itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'cite · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Citation API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'citations · outbox', sub: 'spans · versions', x: 46, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'span cache · TTL', x: 46, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'citation.event', sub: 'key = document_id', x: 46, y: 86},
      {id: 'docstore', kind: 'grpc', label: 'Document store', sub: 'GetVersion · 1 s', x: 70, y: 20},
      {id: 'consumer', kind: 'service', label: 'Verifier consumer', sub: 'group citation-verify', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'span cache'},
      {from: 'api', to: 'db', kind: 'plain', label: 'citation rows · outbox'},
      {from: 'api', to: 'docstore', kind: 'grpc', label: 'GetVersion(doc, version)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce citation.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'docstore', kind: 'grpc', label: 're-anchor spans'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'verification status'},
    ],
  },
  steps: [citationEndpointStep, citationStateStep, citationClientStep, citationEventsStep, readCitationsStep],
};
