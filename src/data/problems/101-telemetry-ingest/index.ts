import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Telemetry ingest: the course is not "accept a JSON body", it is the debugging you owe a pipeline
 * before it feeds a fleet's aggregates. Registry-bound devices with in-range readings → one atomic
 * Redis decision that covers the device's rate and its latest value → batch-scoped time-series
 * writes under a deadline → device-keyed bucketed rollups with an outbox → a series read with a
 * range cap, a named downsampling method and the newest point's age.
 */
export const telemetryIngestProblem: Problem = {
  id: 'telemetry-ingest',
  title: 'Telemetry Ingest',
  tagline:
    'Device telemetry validated against the registry, rate-limited in one Redis script and read back with a range cap.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Telemetry Ingest

A telemetry pipeline is where a fleet's truth is assembled: every dashboard, alert and rollup
downstream is a function of what the ingest edge accepted and acknowledged. What decides whether the
numbers mean anything is the validation funnel, the atomic per-device state, the write contract
with the time-series store, the shape of the events that leave, and the bounds on the reads.

## The real system

Prometheus bounds its read path the way this course's last step does. A \`query_range\` request
names \`start\`, \`end\` and a \`step\`, and the server refuses any request whose span divided by the
step exceeds 11,000 points per series, before any sample is read; each query also runs under a
\`timeout\` capped by the server's \`-query.timeout\` flag. The rest of an ingest edge follows the
same discipline: a device id accepted only when the registry knows it, each reading checked against
its metric's declared range, a per-device rate enforced by a windowed counter that updates the
latest value in the same atomic step, sub-batch writes under a deadline with only the failed
sub-batches retried under one batch id, downsampled rollups keyed by device with an outbox behind
the broker, and a series read that names its downsampling method and the age of its newest point.

## What you build here

One service, **ingestd**, with five pieces:

1. \`POST /v1/telemetry\`: a device id that must exist in the registry, readings inside each
   metric's declared range, and every check run before the ack.
2. A **Redis** decision: per-device windowed sample rates and the latest value per metric, written
   by one atomic Lua \`EVAL\` that rejects before it writes and answers \`429\` with \`Retry-After\`.
3. A **gRPC** time-series client: a 4-second deadline per attempt, retries scoped to the failed
   sub-batches under the same batch id, and a batch reported done only when every point is stored.
4. A **Kafka** rollup path: one \`telemetry.rollup\` event per window keyed by device id, carrying
   bucket means and counts rather than raw samples, with an outbox row when the broker rejects.
5. \`GET /v1/devices/{id}/series\`: a range capped at 24 hours before the store call, downsampling
   beyond 1000 points with the method named, the newest point's age, and a foreign device as \`404\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Device provisioning, firmware-side buffering, schema evolution across device generations,
multi-region ingest, compaction of the time-series store, alerting rules, and the rollup consumer's
own storage.`,
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
