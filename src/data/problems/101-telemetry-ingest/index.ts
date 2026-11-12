import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Telemetry ingest: the course is not "accept a JSON body", it is the debugging you owe a pipeline
 * before it feeds a fleet's aggregates. Registry-bound devices with in-range, current readings → one
 * atomic Redis admission per device window → time-series writes that retry only what failed, under a
 * deadline → device-keyed windowed rollups with an outbox → a series read capped in range and points
 * that keeps the spikes and says how old its newest point is.
 */
export const telemetryIngestProblem: Problem = {
  id: 'telemetry-ingest',
  title: 'Telemetry Ingest',
  tagline: 'Device batches checked against a registry, admitted by a Lua script, stored, rolled up and read back.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Telemetry Ingest

A telemetry pipeline is where a fleet's numbers are assembled: every dashboard, alert and rollup
downstream is a function of what the ingest edge accepted. Whether those numbers mean anything is
decided at five places: what a batch must prove before it is acknowledged, how a device's rate is
counted, what a partial write to the time-series store means, what leaves on the rollup topic, and how
much a single read may ask for.

## The real system

Prometheus bounds the read path the way the last step does: its HTTP API refuses a \`query_range\`
whose span divided by its step would return more than 11,000 points per series, before a sample is
read. Its remote-write specification settles the write side: a sender must retry a request that
failed with a 5xx (or a 429) using backoff, and must not retry one the receiver answered with any
other 4xx, since resending a batch the receiver refused only refuses it again.

## What you build here

One service, **ingestd**, with five pieces around one device registry (\`ingestd.registry\`, provided:
\`lookup\`; provisioning's \`register_device\`), one ingest write-ahead log (\`ingestd.wal\`:
\`append\`) and one time-series store behind gRPC (\`tsdb.TimeSeries\`: \`Write\`, \`Query\`):

1. \`POST /v1/telemetry\`: a registered device, declared metrics, values inside their
   \`[low, high]\` and timestamps inside the ingest window, all checked before the WAL append and the
   \`202\`.
2. A **Redis** admission \`admit(device_id, samples)\`: 600 samples per device per 60-second window,
   the counter \`rate:{device}\` and the latest values \`latest:{device}\` moved by one Lua script that
   refuses before it writes and answers \`retry_after\` from the window's TTL.
3. A **gRPC** writer \`write_batch(batch_id, sub_batches)\`: a 4-second deadline per attempt, three
   attempts, only the failed sub-batches retried under the same batch id, complete only when none
   failed.
4. A **Kafka** rollup \`publish_rollup(device_id, samples)\`: one \`telemetry.rollup\` event per
   device and 60-second window, keyed by device, carrying per-metric mean, count and max, from an
   idempotent \`acks=all\` producer, with an \`outbox\` row when the broker does not acknowledge.
5. \`GET /v1/devices/{id}/series\`: the caller's fleet only, a range of at most 24 hours checked
   before \`Query\`, at most 1000 points that keep the extremes, and the newest point's age.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Device provisioning and authentication, firmware-side buffering, schema evolution across device
generations, the WAL drainer's own scheduling, compaction and retention in the time-series store,
alert rules, and the rollup consumer.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Device fleet', sub: 'batches · samples', x: 8, y: 34},
      {id: 'dashboard', kind: 'client', label: 'Dashboard', sub: 'series reads', x: 8, y: 74},
      {id: 'ingest', kind: 'http', label: 'Telemetry Ingest', sub: 'ingestd', x: 28, y: 50},
      {id: 'registry', kind: 'redis', label: 'Device registry', sub: 'device:{id} · ranges', x: 50, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'rate · latest · WAL · outbox', x: 50, y: 50},
      {id: 'tsdb', kind: 'grpc', label: 'Time-series store', sub: 'Write · Query', x: 72, y: 24},
      {id: 'kafka', kind: 'kafka', label: 'telemetry.rollup', sub: 'key = device', x: 50, y: 88},
      {id: 'rollup', kind: 'service', label: 'Rollup consumer', sub: 'window means · counts', x: 72, y: 88},
    ],
    edges: [
      {from: 'device', to: 'ingest', kind: 'http', label: 'POST /v1/telemetry'},
      {from: 'dashboard', to: 'ingest', kind: 'http', label: 'GET /v1/devices/{id}/series'},
      {from: 'ingest', to: 'registry', kind: 'redis', label: 'lookup(device)'},
      {from: 'ingest', to: 'redis', kind: 'redis', label: 'EVAL admit · WAL append'},
      {from: 'ingest', to: 'tsdb', kind: 'grpc', label: 'Write · 4 s · Query ≤ 24 h'},
      {from: 'ingest', to: 'kafka', kind: 'kafka', label: 'produce rollup · acks=all'},
      {from: 'kafka', to: 'rollup', kind: 'kafka', label: 'consume'},
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
