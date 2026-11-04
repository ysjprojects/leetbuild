import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {monitorEndpointStep} from './steps/1-endpoint';
import {windowedSketchStep} from './steps/2-state';
import {alertClientStep} from './steps/3-client';
import {driftEventsStep} from './steps/4-events';
import {monitorReportStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Drift monitor: the course is not "compute a distance between two histograms", it is the
 * debugging you owe a drift detector before it is trusted to page a human. Validated, idempotent
 * monitor registration → one Redis sketch per window merged by one Lua script, a baseline written
 * once → a page claimed once per (monitor, window) that carries its evidence → a monitor-keyed
 * history with an outbox → a tenant-scoped report that calls out insufficient data. The `drift`
 * support package (monitor store, sketch store, PSI) is what every step shares.
 */
export const driftMonitorProblem: Problem = {
  id: 'drift-monitor',
  title: 'Drift Monitor',
  tagline: 'Windowed Redis sketches against a frozen baseline, and one evidence-carrying page per drifting window.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Drift Monitor

A drift monitor decides when the inputs a model sees have moved far enough from what it was
released on that a human should look. The comparison is the easy part. The hard part is around it:
which traffic counts, what it is compared against, how often it may page, and whether the number it
reports can be trusted.

## The real system

Evidently, the open-source ML monitoring library, always takes two datasets, a **reference** and a
**current** one, and tests each column for drift. Its default test depends on the data: for a
reference of 1000 rows or fewer it runs a two-sample Kolmogorov-Smirnov test on numerical columns;
above that it measures Wasserstein distance against a 0.1 threshold, with PSI, K-L or
Jensen-Shannon on request. The sample size picks the test because a distance on a few dozen rows
means little, which is also why this course reports its counts.

## What you build here

One service, **driftd**, with five pieces on two provided stores: \`drift.store\` (monitors in
\`monitor:{id}\` hashes, the \`Idempotency-Key\` index, the registry's \`registry:promoted\` set,
quiet-tick counters and the \`outbox\` list) and \`drift.sketch\` (step 2's sketch store and its
\`psi\` distance).

1. \`POST /v1/monitors\`: a tenant, a metric from \`METRICS\`, a window of 300 to 86400 s, a promoted
   model version, a frozen \`baseline:{version}:{date}\` reference and an \`Idempotency-Key\`.
2. A **Redis** sketch per window, \`sketch:live:{tenant}:{monitor_id}:{window}\`, merged by one Lua
   script that expires it at the window's end; the baseline under
   \`sketch:baseline:{tenant}:{ref}\`, written once.
3. A **gRPC** \`Alerting.Raise\` with a 1 s deadline, claimed once per \`alert:{monitor_id}:{window}\`
   before the call, carrying the counts and the window, retried with backoff.
4. A **Kafka** \`drift.evaluated\` history keyed by monitor id: crossings, plus a summary every 60
   quiet ticks, from an idempotent producer with \`acks=all\` and an outbox behind it.
5. \`GET /v1/monitors/{id}/report\`: tenant-scoped, with both sample counts, the window, the
   baseline, \`insufficient_data\` below 200 samples, and \`threshold_crossed\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Distance measures beyond PSI, per-feature attribution, retraining triggers, alert routing and
escalation, and backfilling closed windows.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · report', x: 8, y: 50},
      {id: 'monitor', kind: 'http', label: 'Drift Monitor', sub: 'driftd · HTTPS', x: 26, y: 50},
      {id: 'registry', kind: 'db', label: 'model registry', sub: 'registry:promoted', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'monitors · sketches · alert claims', x: 46, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'drift.evaluated', sub: 'key = monitor_id', x: 46, y: 82},
      {id: 'evaluator', kind: 'service', label: 'Window evaluator', sub: 'merge · PSI · counts', x: 68, y: 26},
      {id: 'baseline', kind: 'external', label: 'Baseline sketch', sub: 'SET NX · written once', x: 68, y: 52},
      {id: 'alerting', kind: 'grpc', label: 'Alerting', sub: 'Raise · 1 s', x: 68, y: 74},
      {id: 'consumer', kind: 'service', label: 'History consumer', sub: 'one partition per monitor', x: 68, y: 94},
    ],
    edges: [
      {from: 'client', to: 'monitor', kind: 'http', label: 'HTTPS'},
      {from: 'monitor', to: 'registry', kind: 'plain', label: 'is_promoted'},
      {from: 'monitor', to: 'redis', kind: 'redis', label: 'monitors · report reads'},
      {from: 'evaluator', to: 'redis', kind: 'redis', label: 'EVALSHA merge · SET NX claim'},
      {from: 'evaluator', to: 'baseline', kind: 'plain', label: 'frozen reference'},
      {from: 'evaluator', to: 'alerting', kind: 'grpc', label: 'Raise(evidence)'},
      {from: 'evaluator', to: 'kafka', kind: 'kafka', label: 'crossings · summaries'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [monitorEndpointStep, windowedSketchStep, alertClientStep, driftEventsStep, monitorReportStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
