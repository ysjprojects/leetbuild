import {GRAB} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {scanRequestsStep} from './steps/1-scan-requests';
import {classifyColumnsStep} from './steps/2-classify-columns';
import {scanCacheStep} from './steps/3-scan-cache';
import {verifyEndpointStep} from './steps/4-verify-endpoint';
import {publishClassifiedStep} from './steps/5-publish-classified';

/**
 * Grab's LLM-powered data classification (Gemini, later Metasense), rebuilt as the system around
 * the model: schema-change events consumed, validated, deduplicated and turned into classification
 * jobs before the offset moves → columns tagged by an LLM against a fixed taxonomy, in batches that
 * fit the context window, under a deadline → results cached by schema hash with a daily budget
 * reserved before the call → the owner's verification with the tier derived server-side → the
 * verified classification published once, keyed by entity, and applied to the metadata store before
 * the commit.
 */
export const dataClassificationProblem: Problem = {
  id: 'data-classification',
  title: 'Data Classification',
  tagline:
    "Grab's LLM column tagging for data governance: schema events become classification jobs, tags stay inside a fixed taxonomy and a daily budget, and the owner's verification sets the tier.",
  difficulty: 'medium',
  concepts: ['kafka', 'grpc', 'redis', 'http'],
  tag: 'ai-systems',
  minutes: 60,
  company: GRAB,
  sources: [
    {
      title: 'LLM-powered data classification for data entities at scale',
      url: 'https://engineering.grab.com/llm-powered-data-classification',
      by: 'Hualin Liu, Stefan Jaro, Harvey Li, Jerome Tong, Andrew Lam, Chamal Sapumohotti, Feng Cheng, Aaqib Kufran',
      date: '2024-07-15',
      takes:
        'First published in October 2023 and updated in July 2024, this is the shape of the system: Gemini aggregates scan requests from data platforms into mini-batches through a message queue behind a rate limiter, asks the model to tag every column of an entity against a curated tag library with a <None> default and a fixed JSON output, publishes the predictions to Kafka for owners to verify weekly, and derives the sensitivity tier from the tags plus the privacy office’s rules — at 300–400 entities a day inside a 4000-token context window and a 240K tokens-per-minute quota.',
    },
    {
      title: 'Metasense V2: Enhancing, improving and productionisation of LLM powered data governance',
      url: 'https://engineering.grab.com/metasense-v2',
      by: 'Nick Buhrer, Shreyas Parbat, Yucheng Zeng',
      date: '2024-11-14',
      takes:
        'What a year of production taught: owners still verify every classification, the verification data became the evaluation set, the PII prompt was cut to 8 tags and 737 words, tables over 150 columns are split so the model can attend to each one, and a misclassification-rate alert guards the pipeline — here the 150-column job split, the taxonomy the model may not leave, and the owner verification that feeds the audit trail.',
    },
  ],
  statement: `# Data Classification

A team creates a table with 140 columns at 4 pm, and by policy nobody outside the team may query it
until someone says what is in it. A model can tag every column in seconds; whether the lake gets
safer depends on the service around the model.

## The real system

Grab's **Gemini** (renamed **Metasense**) is the metadata generation service in front of its data
lake. Scan requests are grouped into mini-batches, rate-limited against the model provider, and an
LLM assigns each column one tag from a curated library, or \`None\`. Predictions go to Kafka, the
data owner verifies them, and tags plus the privacy office's rules decide the entity's **sensitivity
tier**, which drives access control and masking.

## From the source

*LLM-powered data classification for data entities at scale* (October 2023, updated July 2024)
describes a workflow-level rate limiter under the provider's quota (a 4000-token context, 240K
tokens per minute), a prompt that makes the model "a database column tag classifier" with a
\`<None>\` default and a JSON array of \`{column_name, assigned_tag}\` as output, and 20 000
entities scanned in the first month at 300 to 400 per day. *Metasense V2* (November 2024) adds what
production taught: owners still verify, verified data becomes the eval set, the prompt shrank from
1254 words to 737, and wide tables are split at 150 columns. This course takes the pipeline shape,
tag library, limits, daily volume, owner verification and tier derivation from those posts; key
formats, deadlines and status codes are this course's.

## What you build here

One service, **metasense**, with five pieces:

1. A **Kafka** intake: consume \`schema.changed\` in group \`metasense\`, validate, split entities
   over **150** columns, skip a seen \`(entity, schema_hash)\`, dead-letter malformed events, commit
   after the enqueue.
2. A **gRPC** classifier client: batches under **3000 tokens**, a **15 s** deadline, one retry on
   \`UNAVAILABLE\`, unknown tags mapped to \`None\`.
3. A **Redis** layer: results under \`classify:{entity}:{schema_hash}\` for 7 days, a daily budget of
   **400** entities reserved atomically before the call, \`verify:{entity}\` with a 7-day expiry.
4. \`POST /v1/entities/{entity_id}/verify\`: the owner acknowledges or edits the tags; the tier is
   derived server-side; **403** for anyone else; every verification is audited.
5. A **Kafka** publish: one \`entity.classified\` event per verification keyed by entity, an
   idempotent producer with \`acks=all\`, an outbox row when the broker refuses, a consumer that
   upserts before it commits.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. Debug
it against the failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

The prompt text, sample-data redaction, prompt evaluation tooling, owner notifications, ABAC
enforcement and dynamic masking.`,
  diagram: {
    nodes: [
      {id: 'platforms', kind: 'client', label: 'Data platforms', sub: 'tables · streams', x: 6, y: 30},
      {id: 'owner', kind: 'client', label: 'Data owner', sub: 'verify tags', x: 6, y: 70},
      {id: 'schema', kind: 'kafka', label: 'schema.changed', sub: 'key = entity', x: 24, y: 30},
      {id: 'metasense', kind: 'http', label: 'metasense', sub: 'HTTPS :8443 · group metasense', x: 42, y: 50},
      {id: 'db', kind: 'db', label: 'jobs · outbox · audit', sub: 'owners · seen hashes', x: 60, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'classify · budget · verify', x: 60, y: 36},
      {id: 'llm', kind: 'grpc', label: 'LLM gateway', sub: 'Classify', x: 60, y: 62},
      {id: 'classified', kind: 'kafka', label: 'entity.classified', sub: 'key = entity', x: 60, y: 88},
      {id: 'catalog', kind: 'service', label: 'Metadata store', sub: 'group metadata-store', x: 80, y: 88},
    ],
    edges: [
      {from: 'platforms', to: 'schema', kind: 'kafka', label: 'produce schema.changed'},
      {from: 'schema', to: 'metasense', kind: 'kafka', label: 'consume'},
      {from: 'owner', to: 'metasense', kind: 'http', label: 'POST …/verify'},
      {from: 'metasense', to: 'db', kind: 'plain', label: 'jobs · outbox · audit'},
      {from: 'metasense', to: 'redis', kind: 'redis', label: 'EVAL budget · GET classify'},
      {from: 'metasense', to: 'llm', kind: 'grpc', label: 'Classify · 15 s'},
      {from: 'metasense', to: 'classified', kind: 'kafka', label: 'produce entity.classified'},
      {from: 'classified', to: 'catalog', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [scanRequestsStep, classifyColumnsStep, scanCacheStep, verifyEndpointStep, publishClassifiedStep],
};
