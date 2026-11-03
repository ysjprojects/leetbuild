import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {redactEndpointStep} from './steps/1-endpoint';
import {redactionStateStep} from './steps/2-state';
import {detectorClientStep} from './steps/3-client';
import {auditEventsStep} from './steps/4-events';
import {readRedactionStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * PII redactor: the debugging you owe a redaction service before it is trusted with customer text.
 * A fail-closed redact endpoint → a per-tenant hourly budget reserved in one Lua script → a gRPC
 * detector client with a deadline, two attempts and a regex fallback that marks itself → one
 * content-free audit event per redaction with an outbox → an audit read that answers offsets, not
 * text. The detector is a stand-in the harness serves over gRPC.
 */
export const piiRedactorProblem: Problem = {
  id: 'pii-redactor',
  title: 'PII Redactor',
  tagline:
    'A redactor that answers 503 when no detector can vouch for the text, and audits with offsets instead of values.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# PII Redactor

A redactor stands between customer text and everything downstream of it. What decides whether it
can be trusted is what it does when it cannot do its job: when the detector is slow or down, when a
tenant sends more than it pays for, and when someone asks later what was removed.

## The real system

Microsoft Presidio, the open-source PII framework, splits the work in two: the analyzer returns a
\`RecognizerResult\` per finding with \`entity_type\`, \`start\`, \`end\` and \`score\`, and the anonymizer
consumes those offsets to replace the text, by default with the entity type in angle brackets. This
course keeps that split: offsets and types are the durable record of a redaction, and the text only
passes through. A hosted redactor adds what Presidio leaves to its operator: a size cap, a budget
per tenant, a detector deadline with a fallback that says it is one, and an audit trail without
values.

## What you build here

One service, the redactor, on three provided modules: \`redactor.spans\` (the \`Span\` and
\`Detection\` types, the eight \`ENTITY_TYPES\`, the regex table \`ENTITY_PATTERNS\` with \`scan\`, and
\`apply_spans\`, \`count_entities\`), \`redactor.ner\` (the detector client \`detect(text, entities)\`,
which step 3 builds) and \`redactor.store\` (the hash \`doc:{document_id}\` through \`save\` and
\`load\`, the list \`outbox:privacy.redacted\` through \`insert_outbox\`).

1. \`POST /v1/redact\`: tenant from \`X-Tenant-Id\`, body \`{document_id, text, entities}\`, a 256 KiB
   cap, a whitelist of entity types, **503** when no detector can answer, every result saved.
2. A **Redis** budget: 2 000 000 characters per tenant per hour under \`budget:{tenant}:{window}\`,
   reserved by one Lua script before the detector is called.
3. The **gRPC** detector client: \`Detector.Detect\` under a 600 ms deadline, a second attempt only
   on transient codes, then the regex fallback marked \`source: "regex"\`, or
   \`DetectorUnavailable\` when a requested type has no pattern.
4. A **Kafka** audit stream: one \`privacy.redacted\` event per redaction keyed by document id,
   offsets and counts only, from an idempotent \`acks=all\` producer whose refused deliveries go to
   the outbox.
5. \`GET /v1/documents/{document_id}/redaction\`: spans, types, counts and the redacted length for
   the owning tenant, **404** for anyone else, and no text.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model training and evaluation, entity taxonomies per language, tenant-specific patterns, redaction
quality metrics, document storage and retention, the outbox relay, and review of false positives.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'redact · audit read', x: 8, y: 50},
      {id: 'redactor', kind: 'http', label: 'Redactor', sub: 'POST /v1/redact · GET …/redaction', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'budget · doc:{id} · outbox', x: 50, y: 14},
      {id: 'detector', kind: 'grpc', label: 'NER detector', sub: 'Detect · 600 ms', x: 50, y: 50},
      {id: 'regex', kind: 'external', label: 'Regex fallback', sub: 'in-process · degraded', x: 72, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'privacy.redacted', sub: 'key = document_id', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'offsets · counts', x: 74, y: 86},
    ],
    edges: [
      {from: 'client', to: 'redactor', kind: 'http', label: 'HTTPS'},
      {from: 'redactor', to: 'redis', kind: 'redis', label: 'EVAL reserve · save · load'},
      {from: 'redactor', to: 'detector', kind: 'grpc', label: 'Detect(text, entities)'},
      {from: 'redactor', to: 'regex', kind: 'plain', label: 'after two failed attempts'},
      {from: 'redactor', to: 'kafka', kind: 'kafka', label: 'produce (outbox on refusal)'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [redactEndpointStep, redactionStateStep, detectorClientStep, auditEventsStep, readRedactionStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
