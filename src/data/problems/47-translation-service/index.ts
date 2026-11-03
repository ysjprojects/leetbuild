import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {translateEndpointStep} from './steps/1-endpoint';
import {glossaryStateStep} from './steps/2-state';
import {mtClientStep} from './steps/3-dependency';
import {localeEventsStep} from './steps/4-events';
import {glossaryReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Translation service: the course is not "call a translation API", it is the debugging you owe a
 * localization layer before it ships a language nobody can read. A validated request pinned to a
 * glossary version → immutable glossary versions and version-keyed translation memory in Redis → an
 * MT call with a deadline whose fallback is marked and never remembered → locale-keyed quality events
 * carrying text hashes, counted before the offset commits → a glossary read for exactly one tenant.
 */
export const translationServiceProblem: Problem = {
  id: 'translation-service',
  title: 'Translation Service',
  tagline:
    'Pinned glossary versions, a marked MT fallback, locale-keyed quality events and a tenant-scoped glossary read.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Translation Service

A translation service turns text in one language into another on demand. The visible part is a
string in French; the parts that decide whether the product is safe are which glossary the
translation used, what happens when the model does not answer, and whose data lands where.

## The real system

Amazon Translate's synchronous \`TranslateText\` caps the input at 10,000 bytes and takes at most one
custom terminology per request; a terminology file is imported ahead of time (up to 20 MB, 100 files
per account and region) and attached to a call by name. Terminology is a versioned resource the
request points at, not a hint in the prompt. This course keeps that discipline.

## What you build here

One service, **translationd**. Steps 2 and 3 are provided to the other steps as \`translate.glossary\`
and \`translate.mt\`; \`translate.text\` (the language detector, \`sha256_hex\`) and
\`translate.outbox\` are provided throughout.

1. \`POST /v1/translations\` with \`{text, source, target, glossary_version?}\` and \`X-Tenant-Id\`:
   text up to 16 KiB, both languages from the allowlist and different, the pinned glossary version
   (**404** when unknown), and \`"marker": "untranslated"\` when the text already is in the target
   language.
2. **Redis** glossary versions \`glossary:{tenant}:{source}:{target}:v{n}\` (immutable, published by
   one Lua script that moves \`:active\`), and translation memory
   \`tm:{tenant}:{source}:{target}:v{n}:{sha256(text)}\` for an hour.
3. A **gRPC** client for \`Translator.Translate\`: a 2-second deadline per attempt, three attempts,
   retries on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\` only, \`PairRejected\` on \`INVALID_ARGUMENT\`, and a
   fallback marked \`untranslated\` (a **503** at the endpoint) that translation memory never keeps.
4. **Kafka** \`translation.done\`, keyed \`{source}->{target}\`, with text hashes in place of text, an
   idempotent producer with \`acks=all\`, an outbox row from the delivery report, and a quality
   consumer that counts into \`quality:{source}->{target}\` before it commits.
5. \`GET /v1/glossaries/{source}/{target}\`: the caller's own glossary with its version and term
   count, pinnable with \`?version=\`, **403** for another tenant's, never held by a shared cache.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model training, translator workbenches, document formats, locale formatting of dates and currencies,
billing, and glossary authoring UIs.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'translate · glossary', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'translationd', sub: 'HTTP · detector', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'glossary versions · TM · outbox', x: 50, y: 22},
      {id: 'mt', kind: 'grpc', label: 'Translator', sub: 'Translate · mt:9000', x: 72, y: 22},
      {id: 'kafka', kind: 'kafka', label: 'translation.done', sub: 'key = source->target', x: 50, y: 80},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'group quality', x: 76, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/translations · GET /v1/glossaries'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'resolve version · TM'},
      {from: 'api', to: 'mt', kind: 'grpc', label: 'Translate · 2 s × 3'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce · outbox on reject'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY quality:{pair}'},
    ],
  },
  steps: [translateEndpointStep, glossaryStateStep, mtClientStep, localeEventsStep, glossaryReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
