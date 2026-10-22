import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Synthetic data on the AI-era track: the course is not "call a model and write the rows out", it is
 * the review you owe a generated dataset before anyone trains on it. Licensed, versioned seeds with
 * a service-enforced cap → per-entity diversity windows in Redis → judge calls that park a timeout
 * instead of admitting it → recipe-keyed record events carrying digests and scores → a provenance
 * report a reviewer can trace back to the seed.
 */
export const syntheticDataProblem: Problem = {
  id: 'synthetic-data',
  title: 'Synthetic Data',
  tagline: 'Generate training data from seeds with diversity, dedupe and honest provenance.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Synthetic Data

A synthetic data service is the piece of an AI platform that turns a small set of licensed seed
records into a corpus big enough to train on. The visible part is a row count in a dashboard; the
parts that decide whether the corpus is worth anything are the seed funnel, the diversity windows,
the judge that scores each record, the events that carry provenance, and the report a reviewer reads
before the set ships.

## The real system

Production generators refuse to expand a seed they cannot account for: the seed dataset must be
registered, its version pinned, and its license must permit derivative work — otherwise the
derivatives are unlicensed the moment they exist. A generation cap belongs to the service, not to
the client that happens to be holding the connection open. Diversity is measured per seed entity
inside the cap: a recipe that regenerates one prolific entity a thousand times is a collapsed
dataset, not a large one, so repeats are throttled per window and the coverage that survives is
reported per entity rather than as a total. Every generated record passes a judge before admission,
under a deadline, and a judge that times out parks the record as unscored instead of quietly
admitting it, because an unscored record is a label with no evidence behind it. Admitted records are
published keyed by recipe so one recipe's admissions stay ordered, carrying seed digests and judge
scores rather than the generated content, and the record is persisted before its admission is
announced. Finally the report is traceable: every admitted record resolves back to the digest of the
seed it came from, coverage is broken down per entity, and a reviewer sees foreign jobs as missing.

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

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

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
