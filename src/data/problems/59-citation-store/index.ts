import type {Problem} from '@/lib/types';

import {citationEndpointStep} from './steps/1-endpoint';
import {citationStateStep} from './steps/2-state';
import {citationClientStep} from './steps/3-client';
import {citationEventsStep} from './steps/4-events';
import {readCitationsStep} from './steps/5-read';

/**
 * Citation store on the AI-era track: the course is not "save a quote and a link", it is the
 * review you owe a model-generated citation store before anyone trusts the answer it supports.
 * Spans that must resolve at write time → a Redis span cache keyed by immutable version → a gRPC
 * document fetch with a deadline that marks unanchored citations broken → document-keyed lineage
 * events with an outbox → a read that names its evidence and reports the worst status.
 */
export const citationStoreProblem: Problem = {
  id: 'citation-store',
  title: 'Citation Store',
  tagline: 'Citations that point at exact spans and stay valid as documents are versioned.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Citation Store

A citation store is the piece of an AI platform that lets an answer name its evidence: this quote,
from this document, at these offsets, in this version. The visible part is a quote under a generated
answer; the parts that decide whether the product is trustworthy are the offset arithmetic, the
version the offsets are resolved against, what happens when the document store cannot answer, and
whether the recorded history of a document's citations survives an edit.

## The real system

Production stores validate the span before they keep it: they take a document id, a version, a
start and an end offset and the quoted text, and they refuse the record when the quote is not
exactly the bytes at those offsets in that version. Offsets are resolved against an immutable
version — never "the document" — because a later edit re-points everything that was stored against a
bare document id. Resolved span text is cached under a key that names the version, with a long TTL,
since an immutable version cannot change. When the document store cannot serve a version, the
service bounds the call with a deadline, treats a missing version as terminal, and marks a citation
it cannot re-anchor as **broken** with a reason rather than dropping it. Verification results are
published keyed by document, so a document's citation history stays ordered, and a broken citation
is published like any other so regressions are visible instead of hidden. The read side returns the
span, its version, its status and the full offset range for the owning tenant only, and an answer's
status is the worst status among its citations.

## What you build here

One service, **citations**, with five pieces:

1. \`POST /v1/citations\`: authenticated tenant, a validated span (version, \`start < end\`, quote
   cap), the quote compared against the bytes at those offsets in the **named version**, an offset
   mismatch answering **422** with both the stored and the supplied text, and an
   \`Idempotency-Key\` so recording the same citation twice cannot diverge.
2. A **Redis** span cache keyed by \`span:{document_id}:{version}:{start}:{end}\` with numeric,
   normalized offsets and a long TTL, because an immutable version never changes and nothing needs
   invalidating.
3. A **gRPC** document fetch: a 1-second deadline per attempt, terminal \`NOT_FOUND\` for a version
   that does not exist, a bounded retry for the retryable codes only, and a citation whose span
   cannot be re-anchored marked \`broken\` with a reason.
4. A **Kafka** \`citation.event\` path keyed by document id, carrying version, span and status, an
   idempotent \`acks=all\` producer, verification before the publish, and an outbox row when the
   broker rejects the produce.
5. \`GET /v1/citations/{id}\`: the span, its document version, its verification status and the full
   offset range for the owning tenant — **404** for a foreign citation — plus an answer's citation
   list that reports the worst status, \`degraded\` when any citation is broken.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Text extraction and OCR pipelines, per-format byte offsets, document storage and retention, span
highlighting UIs, re-anchoring heuristics for rewritten prose, citation quality scoring, answer
generation itself, and cross-document deduplication. The five pieces above are the ones that decide
whether a citation means anything.`,
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
