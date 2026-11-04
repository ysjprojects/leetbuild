import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Synthetic data: the debugging a generation pipeline owes before anyone trains on its output. A
 * licensed, capped, idempotent job → a Redis claim per record in one Lua script (diversity window per
 * seed entity, record cap) → judge calls with a deadline that park a timeout instead of admitting it →
 * recipe-keyed record events carrying the seed digest and the score, with an outbox → a report that
 * counts parked records and traces every admitted one to its seed. The judge is a deterministic
 * stand-in the harness serves over gRPC.
 */
export const syntheticDataProblem: Problem = {
  id: 'synthetic-data',
  title: 'Synthetic Data',
  tagline: 'Licensed seeds, a per-entity window in Redis, a judge with a deadline, a seed digest behind every record.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Synthetic Data

A synthetic data service turns a small set of licensed seed records into a corpus big enough to train
on. The generator is the easy part. What decides whether the corpus is usable is the work around it:
which seeds may be expanded, how often one seed entity may repeat, what the judge said about each
record, and whether a reviewer can trace a record back to the seed it came from.

## The real system

NVIDIA reports that over 98% of the data used to align Nemotron-4 340B was synthetic. Its companion
Nemotron-4-340B-Reward model grades each generated response on five attributes (helpfulness,
correctness, coherence, complexity, verbosity), and the pipeline filters on those grades before a row
reaches training. This course builds the discipline around such a judge: a seed is expanded only if its
license allows derivatives, repeats of one entity are throttled per window, a judge that times out
parks the record instead of passing it, and every admitted record carries the digest of its seed.

## What you build here

One service, **synthd**, with five pieces sharing one contract, the \`synth\` support package
(\`config\`: the judge address, the topic, the window and the key layout; \`seeds\`, \`jobs\`, \`records\`,
\`outbox\`):

1. \`POST /v1/synthetic/jobs\`: a registered seed whose license allows derivatives (422 otherwise), a
   cap of 1..100 000 records, an \`Idempotency-Key\`; the job is stored under \`(tenant, key)\` and only
   then enqueued for the generator workers.
2. **Redis job state**: \`claim(job, entity, max_records)\` is one Lua script over
   \`synth:progress:{job}\` and the window counter \`synth:window:{job}:{entity}:{window}\`: a full job is
   \`cap\`, a sixth record for one entity inside a 60-second window is \`throttled\` and spends no cap,
   otherwise \`generated\` goes up. \`settle\` counts \`admitted\`, \`parked\` or \`rejected\`; an admitted
   record also moves \`synth:coverage:{job}\` and stores its seed digest in \`synth:records:{job}\`.
3. **Judge client** (gRPC, a stand-in the checks serve): a 900 ms deadline per attempt, \`UNAVAILABLE\`
   retried at most twice, a timeout or an outage parks the record, a refusal rejects it, every record
   is judged.
4. **Kafka**: one \`synthetic.record\` event per admitted record keyed by recipe, carrying the seed digest
   and the score but no content, from an idempotent producer, with an outbox row when the broker
   refuses.
5. \`GET /v1/synthetic/jobs/{id}\`: tenant-scoped counts with parked apart from admitted, per-entity
   coverage, and the seed digest of every admitted record.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change. Read the failure mode first, find the line
that produces it, fix the smallest thing, and let the check prove it.

## Left out on purpose

The generator model and its prompts, seed crawling and consent capture, near-duplicate detection,
cost accounting, the outbox relay and the human review queue.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Data curator', sub: 'submit · report', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'synthd', sub: 'API + generator workers', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'jobs · windows · progress · coverage', x: 50, y: 18},
      {id: 'judge', kind: 'grpc', label: 'Judge', sub: 'Score · 900 ms', x: 50, y: 82},
      {id: 'kafka', kind: 'kafka', label: 'synthetic.record', sub: 'key = recipe_id', x: 72, y: 50},
      {id: 'consumer', kind: 'service', label: 'Curation consumer', sub: 'training set', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST / GET jobs'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA claim · settle · HGETALL'},
      {from: 'api', to: 'judge', kind: 'grpc', label: 'Score'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce (digest + score)'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
