import type {Problem} from '@/lib/types';

import {monitorEndpointStep} from './steps/1-endpoint';
import {windowedSketchStep} from './steps/2-state';
import {alertClientStep} from './steps/3-client';
import {driftEventsStep} from './steps/4-events';
import {monitorReportStep} from './steps/5-read';

/**
 * Drift monitor on the AI-era track: the course is not "compute a distance between two histograms",
 * it is the review you owe a model-generated drift detector before it is trusted to page a human.
 * Validated, idempotent monitor registration → windowed sketches merged by one atomic script, with a
 * frozen baseline → alert calls that carry their evidence, deduplicated per (monitor, window) →
 * monitor-keyed history with an outbox → a report that calls out insufficient data.
 */
export const driftMonitorProblem: Problem = {
  id: 'drift-monitor',
  title: 'Drift Monitor',
  tagline: 'Detect input and outcome drift before users notice, without crying wolf.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Drift Monitor

A drift monitor is the piece of an AI platform that decides when a model's inputs or outcomes have
moved far enough from what it was released on that a human should look. The visible part is a number
and a page; the parts that decide whether the monitor is useful at all are the baseline it compares
against, the counts behind the number, the deduplication in front of the pager, and the history that
survives a broker outage.

## The real system

Production drift monitors register what they watch and against what. A monitor names a promoted model
version, one metric — the input distribution, the outcome rate or the calibration curve — a window and
a frozen baseline reference; a monitor whose baseline is the live traffic it is meant to watch
compares the signal with itself and can never fire. Distributions accumulate as sketches in Redis,
merged by one atomic script per batch so concurrent batches cannot lose counts, kept under a key per
(tenant, monitor, window) and expired exactly at the window boundary instead of an hour after the
first write. The baseline sketch is immutable: frozen once, never updated by the live path. When a
window's distance crosses the threshold the monitor calls the alerting service over gRPC under a
1-second deadline, carries the evidence — metric, threshold, distance, both window boundaries and the
sample counts on each side — and deduplicates per (monitor, window) with a cooldown, because a
detector that pages on every batch tick is worse than no detector. Evaluations publish
\`drift.evaluated\` keyed by monitor so one monitor's history stays ordered, routine no-drift ticks are
summarized rather than published one by one, and a rejected produce writes an outbox row so a broker
outage cannot erase an alert from history. The report endpoint answers with the distance, its counts,
its baseline window and an explicit insufficient-data state, scoped to the tenant that owns the
monitor.

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

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Distance measures beyond the three the platform ships (PSI, KS, Jensen–Shannon), feature-level
attribution, automatic retraining triggers, per-feature thresholds, alert routing and escalation
policy, dashboard rendering, and backfill of historical windows. The five pieces above are the ones
that decide whether the monitor is correct, quiet and shippable.`,
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
