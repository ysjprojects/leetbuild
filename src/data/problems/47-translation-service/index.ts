import type {Problem} from '@/lib/types';

import {translateEndpointStep} from './steps/1-endpoint';
import {glossaryCacheStep} from './steps/2-state';
import {mtClientStep} from './steps/3-dependency';
import {localeEventsStep} from './steps/4-events';
import {glossaryReadStep} from './steps/5-read';

/**
 * Translation service: the course is not "call a translation API", it is the debugging you owe a
 * localization layer before it ships a language nobody can read. A validated language pair bound
 * to a tenant's glossary version → tenant-scoped, versioned Redis caches for glossaries and
 * translation memory → an MT call with a deadline whose fallback is *marked*, never a silent
 * identity → locale-keyed quality events with no text in the payload and counters before the
 * offset commit → a glossary read that returns one tenant's terms with the version a caller can
 * pin.
 */
export const translationServiceProblem: Problem = {
  id: 'translation-service',
  title: 'Translation Service',
  tagline: 'Translate on demand with tenant glossaries, marked fallbacks and locale-keyed quality counters.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Translation Service

A translation service turns one language into another on demand: it validates the language pair,
binds the request to a customer's glossary, calls a machine translation model under a deadline,
caches what it can reuse, and reports quality per locale. The visible part is a string in another
language; the parts that decide whether the product is safe are the validation funnel, the cache
key, the failure policy and the metric key.

## The real system

Amazon Translate's synchronous \`TranslateText\` call caps the input at 10,000 bytes of UTF-8 and
accepts one custom terminology file per request, with a 20 MB cap per file and 100 files per account
per region: terminology is a size-bounded resource imported ahead of time and attached to a call by
name, not a free-text hint. A multi-tenant service built on such an API keeps the same discipline.
A glossary is versioned and immutable, so a request pins one version for its whole lifetime and an
edit publishes a new version. Caches are keyed by tenant, locale pair and glossary version, with a
TTL. When the model call fails under its deadline, the service returns the source text with an
untranslated marker and a retriable status, and that response is not cached as a translation.
Each segment emits one quality event keyed by locale pair, carrying text hashes rather than text,
and the consumer updates its counters before it commits the offset.

## What you build here

One service, **translationd**, with five pieces:

1. \`POST /v1/translations\`: authenticated tenant, text capped at **16 KiB**, both languages from
   the platform allowlist, no translation into the source language, a bound glossary version
   (**404** when unknown), and a marker when the text is already in the target language.
2. A **Redis** glossary and translation-memory cache: keys scoped by \`(tenant, locale pair,
   glossary version)\`, a one-hour TTL, and invalidation by version bump.
3. A **gRPC** MT client: a two-second deadline per attempt, bounded attempts, retries only for
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a fallback that returns the source text with an
   untranslated marker and a **503**.
4. A **Kafka** quality path: one \`translation.done\` event per segment keyed by locale pair with
   text hashes only, an idempotent producer with \`acks=all\`, an outbox row when the broker rejects
   the produce, and a consumer that increments its counters before it commits the offset.
5. \`GET /v1/glossaries/{locale}\`: the tenant's active glossary with its version and term count,
   **403** for another tenant's glossary, and a response no cache may hold past the next update.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In each step you debug it against the failure modes the checks describe, fix it,
optimize what is wasteful, and prove the fix with checks that fail on the starter and pass on yours.

## Left out on purpose

Model fine-tuning, translator workbenches, per-locale formatting of dates and currencies, billing,
multi-region deployments, glossary authoring UIs and quality-score model training.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'translate · glossary', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Translation API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'rejected produces', x: 26, y: 86},
      {id: 'glossary', kind: 'db', label: 'Glossary store', sub: 'tenant · versioned', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'glossary · tm caches', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'translation.done', sub: 'key = locale pair', x: 46, y: 86},
      {id: 'mt', kind: 'grpc', label: 'MT service', sub: 'Translate', x: 68, y: 12},
      {id: 'detector', kind: 'service', label: 'Language detector', sub: 'langid', x: 68, y: 38},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'group quality', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'glossary', kind: 'plain', label: 'resolve version'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'glossary · tm'},
      {from: 'api', to: 'mt', kind: 'grpc', label: 'Translate'},
      {from: 'api', to: 'detector', kind: 'plain', label: 'detect'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce translation.done'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'on reject'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY quality'},
      {from: 'redis', to: 'glossary', kind: 'plain', label: 'cached terms'},
    ],
  },
  steps: [translateEndpointStep, glossaryCacheStep, mtClientStep, localeEventsStep, glossaryReadStep],
};
