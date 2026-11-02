import type {Problem} from '@/lib/types';

import {redactEndpointStep} from './steps/1-endpoint';
import {redactionStateStep} from './steps/2-state';
import {detectorClientStep} from './steps/3-client';
import {auditEventsStep} from './steps/4-events';
import {readRedactionStep} from './steps/5-read';

/**
 * PII redactor: the debugging you owe a redaction service before it is trusted with customer text.
 * Fail-closed HTTP, tenant-scoped Redis patterns and an atomic budget, a gRPC detector with a
 * bounded retry and a deterministic regex fallback, content-free audit events with an outbox, and
 * an audit read that returns spans instead of text.
 */
export const piiRedactorProblem: Problem = {
  id: 'pii-redactor',
  title: 'PII Redactor',
  tagline: 'A redactor that answers 503 when the detector is down and audits with offsets, not text.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# PII Redactor

A redactor stands between customer text and everything downstream of it, and what decides whether
it works is what it does when it cannot answer: the failure policy, the tenant boundary in every
key, the fallback detector, and an audit trail that holds no copy of the data it removed.

## The real system

Microsoft Presidio, the open source PII framework, splits the job into an analyzer and an
anonymizer: the analyzer returns a \`RecognizerResult\` per finding with \`entity_type\`, \`start\`,
\`end\` and \`score\`, and the anonymizer consumes those offsets to replace text. That split is the
shape this course builds toward: offsets and counts are the durable record of a redaction, and the
text is what passes through. A hosted redactor adds what Presidio leaves to the operator: a text
cap, per-tenant patterns, a budget reserved before the model is called, a detector deadline with a
regex fallback marked as degraded, and an audit trail of offsets rather than values.

## What you build here

One service, the redactor, with five pieces:

1. \`POST /v1/redact\`: authenticated tenant, a 256 KiB text cap, an entity whitelist, spans plus
   per-type counts plus the pattern version, and a detector failure that answers **503**.
2. A **Redis** pattern cache keyed by \`patterns:{tenant}:{pattern_id}:{version}\` and a per-tenant
   hourly budget of 2 000 000 characters reserved by one Lua \`EVAL\` before the detector runs,
   answering \`429\` with \`Retry-After\` and \`X-RateLimit-Remaining\`.
3. A **gRPC** detector client: a 600 ms deadline per attempt, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a regex fallback over the declared entity types that
   runs for every text size and is marked \`source: "regex"\`.
4. A **Kafka** audit path: one \`privacy.redacted\` event per redaction keyed by document id, a
   content-free payload, a durable idempotent producer, and an outbox row when the produce is
   rejected.
5. \`GET /v1/documents/{id}/redaction\`: spans, entity types, pattern version and redacted length for
   the owning tenant only, no text field, and a **404** for a missing or foreign document.

## The debugging habit

Every starter in this course compiles, serves the happy path and looks right. In every step you
debug it against the failure modes, fix it, optimize what is wasteful, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Model training and evaluation, entity taxonomy governance, per-language pattern packs, redaction
quality metrics, document storage and retention policies, key management for encrypted documents,
and reviewer workflows for false positives.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'redact · audit read', x: 8, y: 50},
      {id: 'redactor', kind: 'http', label: 'Redactor', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'patterns · budget', x: 46, y: 12},
      {id: 'db', kind: 'db', label: 'documents · outbox', sub: 'spans · counts', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'privacy.redacted', sub: 'key = document_id', x: 46, y: 86},
      {id: 'detector', kind: 'grpc', label: 'NER detector', sub: 'Detect · 600 ms', x: 68, y: 20},
      {id: 'regex', kind: 'external', label: 'Regex fallback', sub: 'deterministic · in-process', x: 68, y: 46},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'coverage counters', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'redactor', kind: 'http', label: 'HTTPS'},
      {from: 'redactor', to: 'redis', kind: 'redis', label: 'patterns · reserve'},
      {from: 'redactor', to: 'db', kind: 'plain', label: 'spans · outbox'},
      {from: 'redactor', to: 'detector', kind: 'grpc', label: 'Detect(text, entities)'},
      {from: 'redactor', to: 'regex', kind: 'plain', label: 'on deadline / unavailable'},
      {from: 'redactor', to: 'kafka', kind: 'kafka', label: 'produce privacy.redacted'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY coverage'},
    ],
  },
  steps: [redactEndpointStep, redactionStateStep, detectorClientStep, auditEventsStep, readRedactionStep],
};
