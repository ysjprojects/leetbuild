import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Telemetry ingest on the AI-era track: the course is not "accept a JSON body", it is the review
 * you owe a model-generated pipeline before it feeds a fleet's aggregates. Registry-bound devices
 * with in-range readings → one atomic Redis decision that covers the device's rate and its latest
 * value → batch-scoped time-series writes under a deadline → device-keyed bucketed rollups with an
 * outbox → a series read with a range cap, a named downsampling method and honest staleness.
 */
export const telemetryIngestProblem: Problem = {
  id: 'telemetry-ingest',
  title: 'Telemetry Ingest',
  tagline: 'High-volume device telemetry with registry-bound devices and honest acks.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Telemetry Ingest

A telemetry pipeline is where a fleet's truth is assembled: every dashboard, alert and rollup
downstream is a function of what the ingest edge accepted and what it acknowledged. The visible
part is one \`POST /v1/telemetry\`; the parts that decide whether the numbers mean anything are the
validation funnel, the atomic per-device state, the write contract with the time-series store, the
shape of the events that leave the pipeline, and the bounds on the reads that come back.

## The real system

Production ingest edges take millions of samples a minute from devices they do not control. They
accept a device id only when the registry already knows it — an ingest path that invents registry
rows turns a typo, a cloned firmware image or an attacker into a permanent fleet member, and every
aggregate it touches afterwards. They check each reading against the range the metric declares, so a
single overflow value cannot rescale a fleet's graph to zero. They enforce a per-device sample rate
with a windowed counter, and they update a device's latest value in the same atomic step, because a
rate breach must not half-apply. They write to the time-series store in sub-batches under a
deadline, and when a sub-batch fails they retry only that one under the same batch id, because a
store that does not dedupe will double a fleet's totals if the whole batch is re-sent. They publish
downsampled rollups keyed by device so a device's stream stays ordered, and they never let a broker
outage drop an event. And they bound every read: a range cap, a named downsampling method, and the
age of the newest point, so a device that went silent is visible instead of looking flat.

## What you build here

One service, **ingestd**, with five pieces:

1. \`POST /v1/telemetry\`: a batch declares a device id that must exist in the registry, readings
   inside each metric's declared range, and a batch id; an unknown device is \`404\` and creates no
   registry state, out-of-range readings are rejected with the metric named, and every check runs
   before the batch is acknowledged.
2. A **Redis** decision: per-device windowed sample rates and the latest value per metric, written
   by one atomic Lua \`EVAL\` that rejects before it writes, expires with its window, and answers
   \`429\` with \`Retry-After\` and \`X-RateLimit-Remaining\`.
3. A **gRPC** time-series client: a 4-second deadline per attempt, a partial write response naming
   the accepted and failed sub-batches, retries scoped to the failed ones under the same batch id,
   and a batch reported done only when every point is stored.
4. A **Kafka** rollup path: one \`telemetry.rollup\` event per window keyed by device id, carrying
   bucket means and counts rather than raw samples, with an outbox row when the broker rejects the
   produce.
5. \`GET /v1/devices/{id}/series\`: a range capped at 24 hours and enforced before the store call,
   downsampling beyond 1000 points with the method named in the response, the newest point's age
   reported, and a device from another fleet answered as \`404\`.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real ingest
edge: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version.

## Left out on purpose

Device provisioning and certificate distribution, firmware-side buffering, schema evolution across
device generations, multi-region ingest, backfill and compaction of the time-series store, alerting
rules, and the rollup consumer's own storage. The five pieces above are the ones that decide whether
the pipeline's numbers can be trusted.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Device fleet', sub: 'batches · samples', x: 8, y: 34},
      {id: 'dashboard', kind: 'client', label: 'Dashboard', sub: 'series reads', x: 8, y: 74},
      {id: 'ingest', kind: 'http', label: 'Telemetry Ingest', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'registry', kind: 'db', label: 'Device registry', sub: 'devices · metric ranges', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'rate · latest value', x: 48, y: 50},
      {id: 'tsdb', kind: 'grpc', label: 'Time-series store', sub: 'Write · Query', x: 70, y: 14},
      {id: 'kafka', kind: 'kafka', label: 'telemetry.rollup', sub: 'key = device', x: 48, y: 88},
      {id: 'rollup', kind: 'service', label: 'Rollup consumer', sub: 'bucket means · counts', x: 70, y: 88},
    ],
    edges: [
      {from: 'device', to: 'ingest', kind: 'http', label: 'POST /v1/telemetry'},
      {from: 'dashboard', to: 'ingest', kind: 'http', label: 'GET /v1/devices/{id}/series'},
      {from: 'ingest', to: 'registry', kind: 'plain', label: 'device · metric ranges'},
      {from: 'ingest', to: 'redis', kind: 'redis', label: 'rate · latest'},
      {from: 'ingest', to: 'tsdb', kind: 'grpc', label: 'Write · deadline 4 s'},
      {from: 'ingest', to: 'tsdb', kind: 'plain', label: 'Query · range ≤ 24 h'},
      {from: 'ingest', to: 'kafka', kind: 'kafka', label: 'produce telemetry.rollup'},
      {from: 'kafka', to: 'rollup', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
