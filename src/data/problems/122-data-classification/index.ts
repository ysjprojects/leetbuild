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
    "Grab's LLM column tagging for data governance: schema events to jobs, taxonomy-bound classification in batches, a daily budget, owner verification and a tiered publish — reviewed like production.",
  difficulty: 'medium',
  concepts: ['kafka', 'grpc', 'redis', 'http'],
  track: 'ai',
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
until someone says what is in it. Half the schemas in the lake are Tier 1 — the strictest tier —
because one table in each schema once held a passport number and nobody has had time to look at the
other hundred. A model can tag every column in seconds. What decides whether the lake gets safer or
just gets a confident second opinion is the service around the model: what it feeds in, what it
refuses to accept back, what it costs per day, and who signs off.

## The real system

Grab's **Gemini** (renamed **Metasense**) is the metadata generation service in front of its data
lake. Data platforms send scan requests when entities appear or change; the service aggregates them
into mini-batches through a message queue, rate-limits itself against the model provider, and asks
an LLM to assign each column exactly one tag from a curated library — \`Personal.ID\`,
\`Personal.Name\`, \`Personal.Contact_Info\`, \`Geo.Geohash\`, … or \`None\` when nothing fits. The
predictions go to Kafka, downstream platforms show them to the data owner, and the owner verifies
them. The tags, combined with the privacy office's rules, decide the entity's **sensitivity tier**,
which drives attribute-based access control and dynamic masking. A year in, the service covers most
of the lake, owners change fewer than one tag per table, and the verification data is the eval set
for every new prompt.

## From the source

*LLM-powered data classification for data entities at scale* (October 2023, updated July 2024)
describes the orchestration: data platforms trigger scans, Gemini groups them into mini-batches
at fixed intervals from a message queue, and a workflow-level rate limiter keeps the service under
the provider's quota — a 4000-token context window and 240K tokens per minute across one Azure
OpenAI account at the time. The prompt makes the model "a database column tag classifier": one tag
per column, a \`<None>\` default when it is unsure, a few-shot example, and a JSON array of
\`{column_name, assigned_tag}\` enforced as the output shape so downstream code can parse it. The
post reports 20 000 entities scanned in the first month at 300–400 per day, says cost was far lower
than intuition suggests, and that tags plus privacy rules yield the tier used for ABAC and masking.
*Metasense V2* (November 2024) adds what production taught: owners still verify, the verified data
trains the next prompt, the PII prompt shrank from 21 tags to 8 and from 1254 words to 737, tables
with more than 150 columns are split so the model can attend to each column, and a misclassification
alert watches the pipeline. This course takes the pipeline shape, the tag library, the \`<None>\`
default, the token and column limits, the daily volume, the owner verification and the tier
derivation from those two posts; the key formats, deadlines and status codes are this course's.

## What you build here

One service, **metasense**, with five pieces:

1. A **Kafka** intake: consume \`schema.changed\` events (entity, columns, owner) from the group
   \`metasense\`, validate them, split entities with more than **150** columns into several jobs,
   skip an \`(entity, schema_hash)\` already seen, send malformed events to \`schema.changed.dlq\`,
   and commit the offset only after the job is durably enqueued.
2. A **gRPC** classifier client: \`Classify(entity, columns)\` against the LLM gateway in batches
   that fit a **3000-token** prompt budget, a **15 s** deadline per call, one retry on
   \`UNAVAILABLE\`, and a reply parsed defensively — any tag outside the taxonomy becomes \`None\`.
3. A **Redis** layer: results cached under \`classify:{entity}:{schema_hash}\` for 7 days, a daily
   budget of **400** entities reserved by one atomic script before any model call, and the pending
   verification kept under \`verify:{entity}\` with a 7-day expiry.
4. \`POST /v1/entities/{entity_id}/verify\`: the owner acknowledges or edits the tags; the tier is
   derived server-side from tags and privacy rules, never read from the body; **403** for anyone but
   the owner; every verification is audited with who did it.
5. A **Kafka** publish: one \`entity.classified\` event per verification keyed by entity, an
   idempotent producer with \`acks=all\`, an outbox row when the broker refuses, and a consumer that
   upserts the metadata store before it commits.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real data
governance feature: read the draft against the failure modes, name the subtle one, fix it, and prove
the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

The prompt text itself, sample-data redaction, the third-party classification engine Gemini ran in
parallel, prompt evaluation tooling, the weekly owner notification, ABAC policy enforcement and
dynamic masking, and the misclassification-rate alert. The five pieces above are the ones that decide
whether the classification is correct, affordable and trusted enough to open a table on.`,
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
