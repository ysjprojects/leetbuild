import type {Problem} from '@/lib/types';

import {monitorEndpointStep} from './steps/1-endpoint';
import {windowedSketchStep} from './steps/2-state';
import {alertClientStep} from './steps/3-client';
import {driftEventsStep} from './steps/4-events';
import {monitorReportStep} from './steps/5-read';

/**
 * Drift monitor: the course is not "compute a distance between two histograms", it is the
 * debugging you owe a drift detector before it is trusted to page a human. Validated, idempotent
 * monitor registration → windowed sketches merged by one atomic script, with a frozen baseline →
 * alert calls that carry their evidence, deduplicated per (monitor, window) → monitor-keyed history
 * with an outbox → a report that calls out insufficient data.
 */
export const driftMonitorProblem: Problem = {
  id: 'drift-monitor',
  title: 'Drift Monitor',
  tagline: 'Frozen baselines, atomic sketch merges and a pager that fires once per window.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Drift Monitor

A drift monitor decides when a model's inputs or outcomes have moved far enough from what it was
released on that a human should look.

## The real system

Evidently, the open source monitoring library, frames drift exactly this way: a current dataset is
compared against a separately supplied reference dataset, column by column, with a statistical test
chosen per column type (Kolmogorov-Smirnov by default for numerical columns, with PSI and
Jensen-Shannon selectable) and a per-column drift score next to the verdict. The reference is an
input you hand it, not something it derives from the traffic it is judging, and the report carries
the sample sizes behind every score.

A service that runs that comparison continuously has to own more than the test: a monitor whose
baseline is the live traffic compares the signal with itself and cannot fire, and an alert without
sample counts cannot be told apart from noise.

## What you build here

One service, **driftd**, with five pieces:

1. \`POST /v1/monitors\`: authenticated tenant, a metric whitelist, a window range, a **promoted**
   model version, a **frozen** baseline reference and an \`Idempotency-Key\`, so a retry returns the
   original monitor instead of registering a second one.
2. A **Redis** sketch store: windowed sketches per \`(tenant, monitor_id, window)\` merged by one
   atomic Lua \`EVAL\` per batch, an immutable baseline under its own key prefix, and \`EXPIRE\` set to
   the window boundary rather than a fixed hour.
3. A **gRPC** alert client: a 1-second deadline per attempt, an alert deduplicated per
   \`(monitor, window)\` with a cooldown claimed before the call, a payload that carries the counts and
   both boundaries, and a bounded retry with backoff instead of a silent drop.
4. A **Kafka** history: \`drift.evaluated\` keyed by monitor id, only threshold crossings (plus
   periodic summaries) published, an idempotent producer with \`acks=all\`, and an outbox row when the
   broker rejects the produce.
5. \`GET /v1/monitors/{id}/report\`: the distance with its sample counts and baseline window, an
   explicit \`insufficient_data\` state below the sample floor, and a **404** for a foreign monitor.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Distance measures beyond PSI, KS and Jensen–Shannon, feature-level attribution, retraining
triggers, alert routing, and backfill of historical windows.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'register · report', x: 8, y: 50},
      {id: 'monitor', kind: 'http', label: 'Drift Monitor', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'registry', kind: 'db', label: 'model registry · monitors', sub: 'promoted versions', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sketches · dedupe', x: 46, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'drift.evaluated', sub: 'key = monitor_id', x: 46, y: 82},
      {id: 'evaluator', kind: 'service', label: 'Window evaluator', sub: 'distance · counts', x: 68, y: 26},
      {id: 'baseline', kind: 'external', label: 'Baseline sketch', sub: 'frozen · write once', x: 68, y: 52},
      {id: 'alerting', kind: 'grpc', label: 'Alerting', sub: 'Raise · 1 s', x: 68, y: 74},
      {id: 'consumer', kind: 'service', label: 'History consumer', sub: 'counters · summaries', x: 68, y: 94},
    ],
    edges: [
      {from: 'client', to: 'monitor', kind: 'http', label: 'HTTPS'},
      {from: 'monitor', to: 'registry', kind: 'plain', label: 'is_promoted · monitor'},
      {from: 'monitor', to: 'redis', kind: 'redis', label: 'merge batch · dedupe'},
      {from: 'monitor', to: 'evaluator', kind: 'plain', label: 'distance'},
      {from: 'evaluator', to: 'baseline', kind: 'plain', label: 'frozen reference'},
      {from: 'monitor', to: 'alerting', kind: 'grpc', label: 'Raise(evidence)'},
      {from: 'monitor', to: 'kafka', kind: 'kafka', label: 'produce drift.evaluated'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY history'},
    ],
  },
  steps: [monitorEndpointStep, windowedSketchStep, alertClientStep, driftEventsStep, monitorReportStep],
};
