import type {Problem} from '@/lib/types';

import {experimentEndpointStep} from './steps/1-endpoint';
import {experimentStateStep} from './steps/2-state';
import {experimentClientStep} from './steps/3-dependency';
import {experimentEventsStep} from './steps/4-events';
import {experimentReadStep} from './steps/5-read';

/**
 * Experiment platform: the course is not "read the A/B dashboard", it is the debugging you owe an
 * experiment service before anyone ships a decision on it. Splits and the assignment unit frozen at
 * start → one deterministic Redis bucket per unit that never re-randomizes → guardrail checks over
 * gRPC that pause a ramp instead of ignoring it → exposure events keyed by experiment with a unit
 * dedupe before publish → a report that refuses to name a winner on a peek or on a mismatched split.
 */
export const experimentsPlatformProblem: Problem = {
  id: 'experiments-platform',
  title: 'Experiment Platform',
  tagline: 'A/B experiments with frozen assignment, guardrail-gated ramps and reports that refuse a peek.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Experiment Platform

An experiment platform is the piece of a product that decides which variant a user sees, when an
experiment may take more traffic, and whether the number on the final report means anything. The
visible part is a variant in a response; the parts that decide whether the platform can be trusted
are the assignment that is frozen before launch, the bucket that stays put, the gate in front of
every traffic increase, the exposure stream the analysis is built from, and the report that refuses
to call a winner it has not earned.

## The real system

GrowthBook, the open source feature-flag and experimentation platform, puts a sample ratio
mismatch warning at the top of an experiment's results page when the observed variant counts
diverge from the configured split, because a mismatch means the assignment itself is suspect and
no metric below it can be read. Its ramp schedules can hold a step until a minimum number of users
has been exposed, so traffic grows on evidence rather than on a timer. The same pattern shows up in
every serious platform: the design (variants, split, randomization unit, required sample) is pinned
when the experiment starts and a later edit becomes a new version; assignment is a pure function of
experiment id, unit and a frozen salt, cached per experiment so a split edit cannot move a user
between arms; each ramp step asks a stats service whether a guardrail metric breached its bound and
pauses with the metric named; exposures are keyed by experiment, carry a unit hash rather than an
identity, are deduplicated on (experiment, unit, variant), and are applied to analysis state before
the consumer commits; and the read side waits for the minimum sample, treats SRM as blocking, and
shows every lift with its interval.

## What you build here

One service, **expd**, with five pieces:

1. \`POST /v1/experiments\`: validated variants, an assignment unit of \`user\`/\`session\`/\`account\`,
   a traffic split that sums to exactly **100**, a minimum sample size and a frozen salt, all
   immutable for the life of the experiment; a mid-flight change is **409** and asks for a new
   version.
2. A **Redis** assignment cache keyed by \`(experiment, unit)\` under a hash over
   \`(experiment, unit, salt)\`: the bucket is computed once and cached so a read never re-buckets,
   new units keep filling the frozen split, and a disabled experiment keeps serving the last
   assignment instead of flipping everyone to control.
3. A **gRPC** guardrail check before every ramp step: a **2-second** deadline, a breached metric
   pausing the ramp with the metric named, no caller override, and no ramp on a paused experiment
   without a fresh passing check.
4. A **Kafka** \`experiment.exposure\` topic keyed by experiment id, carrying variant, unit hash and
   timestamp with a dedupe key of \`(experiment, unit, variant)\` enforced before publish, an
   idempotent producer, and a consumer that writes analysis state before committing the offset.
5. \`GET /v1/experiments/{id}/report\`: **inconclusive** before the minimum sample, a sample ratio
   mismatch above **2 %** reported as a blocking caveat, and every lift shown with its confidence
   interval.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real experiment feature: debug
it against the failure modes, fix it, optimize what is wasteful, and prove the fix with checks that
fail on the starter and pass on your version.

## Left out on purpose

Metric definitions and the stats library, sequential test design, multi-armed bandits and adaptive
allocation, targeting rules and audience segmentation, identity stitching across devices, per-tenant
experiment quotas, and the dashboard that renders the report. The five pieces above are the ones that
decide whether an experiment's assignment is stable and its conclusion can be trusted.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'assign · report', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Experiment API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'store', kind: 'db', label: 'experiment store', sub: 'variants · splits · salt', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'assignments · dedupe', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'experiment.exposure', sub: 'key = experiment id', x: 50, y: 88},
      {id: 'stats', kind: 'grpc', label: 'Stats service', sub: 'Guardrails · 2 s', x: 74, y: 20},
      {id: 'consumer', kind: 'service', label: 'Analysis consumer', sub: 'group exposure-stats', x: 74, y: 62},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'variants · splits'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'assignments · dedupe'},
      {from: 'api', to: 'stats', kind: 'grpc', label: 'CheckGuardrails'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce experiment.exposure'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'dedupe (experiment, unit, variant)'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'sample · SRM rows'},
    ],
  },
  steps: [experimentEndpointStep, experimentStateStep, experimentClientStep, experimentEventsStep, experimentReadStep],
};
