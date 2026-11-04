import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Experiment platform: the course is not "read the A/B dashboard", it is the debugging you owe an
 * experiment service before anyone ships a decision on it. A design that runs exactly as approved →
 * a sticky Redis assignment per experiment and unit → a guardrail check in front of every ramp →
 * exposure events counted once per unit, keyed by experiment → a report that will not name a
 * winner before the sample, on a broken split, or without its interval.
 */
export const experimentsPlatformProblem: Problem = {
  id: 'experiments-platform',
  title: 'Experiment Platform',
  tagline:
    'Frozen splits, sticky Redis buckets, guardrail-gated ramps, exposure events and a report that waits for its sample.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Experiment Platform

An experiment platform decides which variant a unit sees, when an experiment may take more traffic,
and whether the final report means anything. Each of those decisions rests on the one before it: a
report is only as good as the exposures it counts, the exposures only as good as the assignments,
and the assignments only as good as a design that does not move under them.

## The real system

GrowthBook, the open source experimentation platform, assigns a unit by hashing the experiment's
seed with the unit's id using 32-bit FNV-1a, so any SDK computes the same bucket without a network
call. Because a changed split or seed would re-bucket units mid-test, it offers Sticky Bucketing:
a store of each unit's first assignment that keeps it in its variation when targeting, rollout or
bucketing settings change. This course builds that shape server-side, with the same hash.

## What you build here

One service, **expd**, on a provided package \`expd\`: \`expd.store\` (experiments as Redis hashes
\`exp:{id}\`, plus the counts \`exp:{id}:exposures\` and \`exp:{id}:conversions\`), \`expd.bucket\`
(\`bucket_of\`, \`variant_for\`) and \`expd.stats\` (\`compare\`: lift, interval, p-value).

1. \`POST /v1/experiments\`, \`PATCH /v1/experiments/{id}\`: a split summing to exactly **100**, a
   unit of \`user\`, \`session\` or \`account\`, and a design that a \`PATCH\` cannot change (**409**,
   new version).
2. \`assign(experiment_id, unit_id)\`: a **Redis** assignment under
   \`exp:{experiment_id}:assign:{unit_id}\`, read first and written with \`SET NX\`.
3. \`POST /v1/experiments/{id}/ramp\`: a **gRPC** \`Guardrails.CheckGuardrails\` call under a
   **2-second** deadline before any traffic moves; a breach pauses the experiment.
4. \`record_exposure\` and \`consume_exposures\`: a **Kafka** \`experiment.exposure\` stream keyed by
   experiment id, one event per unit (a Redis claim \`exp:{id}:seen:{unit}\`), counted before commit.
5. \`GET /v1/experiments/{id}/report\`: **inconclusive** below the minimum sample, **blocked** on a
   sample ratio mismatch above **2 %**, and every lift with its 95 % interval.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Metric definitions and the warehouse that computes them, targeting rules, mutually exclusive
layers, sequential testing and bandits, cross-device identity, and the dashboard that renders the
report.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'assign · ramp · report', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'expd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'store', kind: 'db', label: 'experiment store', sub: 'exp:{id} · split · salt', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'assign · seen · counts', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'experiment.exposure', sub: 'key = experiment id', x: 50, y: 88},
      {id: 'stats', kind: 'grpc', label: 'Stats service', sub: 'CheckGuardrails · 2 s', x: 74, y: 20},
      {id: 'consumer', kind: 'service', label: 'Exposure consumer', sub: 'group exposure-stats', x: 74, y: 70},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'create · get · set_status'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX assignment · claim'},
      {from: 'api', to: 'stats', kind: 'grpc', label: 'CheckGuardrails'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce exposure'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY exposures, then commit'},
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
