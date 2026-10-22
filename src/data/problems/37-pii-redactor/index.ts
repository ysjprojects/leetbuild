import type {Problem} from '@/lib/types';

import {redactEndpointStep} from './steps/1-endpoint';
import {redactionStateStep} from './steps/2-state';
import {detectorClientStep} from './steps/3-client';
import {auditEventsStep} from './steps/4-events';
import {readRedactionStep} from './steps/5-read';

/**
 * PII redactor on the AI-era track: the course is not "call an NER model and replace some
 * strings", it is the review you owe a model-generated redaction service before it is trusted with
 * customer text. Fail-closed HTTP → tenant-scoped Redis patterns and an atomic budget → a gRPC
 * detector with a bounded retry and a deterministic regex fallback → content-free audit events
 * with an outbox → an audit read that returns spans, never text.
 */
export const piiRedactorProblem: Problem = {
  id: 'pii-redactor',
  title: 'PII Redactor',
  tagline: 'Redaction that fails closed, proves its spans, and never stores what it removed.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# PII Redactor

A redactor is the piece of an AI platform that stands between customer text and everything
downstream of it, and the only thing that decides whether it works is what it does when it cannot
answer. The visible part is a redacted string; the parts that decide whether the system is safe are
the failure policy, the tenant boundary in every key, the fallback detector, and the audit trail
that must never become a second copy of the data it removed.

## The real system

Production redactors accept text up to a hard cap, validate the entity types the caller asks for,
and resolve custom patterns per tenant, cached under a versioned key. They meter work before spending
it, atomically, so an over-budget request never reaches the model. They call an NER model over gRPC
under a short deadline, retry only the statuses worth retrying and only a bounded number of times,
and when the model is unavailable they redact with a deterministic regex pass that is *marked* as
degraded rather than quietly skipped. They publish an audit event per redaction that carries offsets
and counts — never a removed value — and they write an outbox row when the broker refuses it. And
they expose the audit record as spans, scoped to the tenant, so a caller can prove coverage without
the system ever transferring text.

## What you build here

One service, the redactor, with five pieces:

1. \`POST /v1/redact\`: authenticated tenant, a 256 KiB text cap, an entity whitelist, spans plus
   per-type counts plus the pattern version in the response, and a detector failure that answers
   **503** instead of falling back to the input.
2. A **Redis** pattern cache keyed by \`patterns:{tenant}:{pattern_id}:{version}\` and a per-tenant
   hourly budget of 2 000 000 characters reserved by one atomic Lua \`EVAL\` before the detector runs,
   answering \`429\` with \`Retry-After\` and \`X-RateLimit-Remaining\`.
3. A **gRPC** detector client: a 600 ms deadline per attempt, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a deterministic regex fallback over the declared entity
   types that runs for every text size and is marked \`source: "regex"\`.
4. A **Kafka** audit path: one \`privacy.redacted\` event per redaction keyed by document id, a
   content-free payload (spans, counts, pattern version), a durable idempotent producer, and an
   outbox row when the produce is rejected.
5. \`GET /v1/documents/{id}/redaction\`: spans, entity types, pattern version and redacted length for
   the owning tenant only — no text field of any kind, and a **404** for a missing or foreign
   document rather than a 403.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model training and evaluation, entity taxonomy governance, per-language pattern packs, redaction
quality metrics, document storage and retention policies, key management for encrypted documents,
and reviewer workflows for false positives. The five pieces above are the ones that decide whether
the redactor is correct, isolated and shippable.`,
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
