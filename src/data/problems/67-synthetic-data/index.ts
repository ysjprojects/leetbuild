import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Synthetic data: the course is not "call a model and write the rows out", it is the debugging
 * you owe a generation pipeline before anyone trains on its output. Licensed, versioned seeds with
 * a service-enforced cap → per-entity diversity windows in Redis → judge calls that park a timeout
 * instead of admitting it → recipe-keyed record events carrying digests and scores → a provenance
 * report a data reviewer can trace back to the seed.
 */
export const syntheticDataProblem: Problem = {
  id: 'synthetic-data',
  title: 'Synthetic Data',
  tagline: 'Expand licensed seeds into a scored, per-entity corpus with a digest behind every record.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Synthetic Data

A synthetic data service is the piece of an AI platform that turns a small set of licensed seed
records into a corpus big enough to train on. The visible part is a row count in a dashboard; the
parts that decide whether the corpus is worth anything are the seed funnel, the diversity windows,
the judge that scores each record, the events that carry provenance, and the report a data reviewer
reads before the set ships.

## The real system

NVIDIA's NeMo Curator ships the generation pipelines used to build Nemotron-4 340B, a model whose
supervised fine-tuning data was 98% synthetic. Every generated conversation is sent to a reward
model that returns separate helpfulness, correctness, coherence, complexity and verbosity scores,
and the pipeline filters on those scores before the row reaches training; a list the model fails
to return in the requested shape raises a conversion error instead of being accepted short. The
service in this course applies the same discipline earlier in the funnel: a seed is expanded only
if its registered license permits derivatives, the record cap belongs to the service rather than
to the client holding the connection, repeats of one seed entity are throttled per window so a
prolific entity cannot fill the quota, and a judge call that times out parks the record as
unscored. Admitted records are published keyed by recipe so one recipe's history stays ordered,
carrying seed digests and judge scores rather than text, and the record is persisted before the
event announces it. The report resolves every admitted record to the digest of its seed, breaks
coverage down per entity, and answers a foreign job id with 404.

## What you build here

One service, **synthd**, with five pieces:

1. \`POST /v1/synthetic/jobs\`: authenticated tenant, a registered and versioned seed dataset whose
   license allows derivatives (**422** otherwise, before any generation), a 1..100000 record cap the
   service enforces, and an \`Idempotency-Key\` so a retried submit resumes the same job.
2. A **Redis** coverage ledger: per-entity counters inside a windowed key with a TTL tied to the
   window, throttling repeats of one seed entity inside the record cap, all moved by one atomic
   script, and a final report that counts per-entity coverage instead of totals alone.
3. A **gRPC** judge client: a 900 ms deadline per record, a timeout that parks the record as
   unscored with a count in the report, a refusal that is terminal, and judging that covers every
   admitted record rather than a cheap prefix.
4. A **Kafka** record path: one \`synthetic.record\` event per admission keyed by recipe id, an
   idempotent producer with \`acks=all\`, seed digests and judge scores instead of generated content,
   and a record that is persisted before its event is published.
5. \`GET /v1/synthetic/jobs/{id}\`: tenant-scoped, reporting generated, admitted, parked and rejected
   counts plus per-entity coverage and the judge version, where every admitted record resolves to a
   seed digest.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real data pipeline: debug it
against the failure modes, fix it, optimize what is wasteful, and prove the fix with checks that
fail on the starter and pass on your version.

## Left out on purpose

Seed crawling and consent capture, generation model fine-tuning, prompt templates per entity,
dedupe across recipes, cost accounting for generation and judging, human review queues, training
pipelines and the dashboard. The five pieces above are the ones that decide whether the corpus is
licensable, diverse, scored and traceable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Data curator', sub: 'submit · report', x: 8, y: 50},
      {id: 'synth', kind: 'http', label: 'Synthetic Data', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'seeds · jobs', sub: 'licenses · outbox', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'coverage windows', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'synthetic.record', sub: 'key = recipe', x: 48, y: 90},
      {id: 'judge', kind: 'grpc', label: 'Judge service', sub: 'Score', x: 70, y: 10},
      {id: 'generator', kind: 'service', label: 'Generator workers', sub: 'expand · score · publish', x: 70, y: 48},
      {id: 'consumer', kind: 'service', label: 'Coverage consumer', sub: 'fold coverage', x: 70, y: 84},
    ],
    edges: [
      {from: 'client', to: 'synth', kind: 'http', label: 'HTTPS'},
      {from: 'synth', to: 'db', kind: 'plain', label: 'seeds · jobs · licenses'},
      {from: 'synth', to: 'redis', kind: 'redis', label: 'coverage windows'},
      {from: 'synth', to: 'kafka', kind: 'kafka', label: 'produce synthetic.record'},
      {from: 'kafka', to: 'generator', kind: 'kafka', label: 'consume recipe'},
      {from: 'generator', to: 'judge', kind: 'grpc', label: 'Score'},
      {from: 'generator', to: 'redis', kind: 'redis', label: 'coverage windows'},
      {from: 'generator', to: 'kafka', kind: 'kafka', label: 'produce admitted'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY coverage'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'persist admission'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
